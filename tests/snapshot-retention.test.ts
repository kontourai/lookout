// Snapshot history is bounded by Forage's retention: the check runner prunes
// after each stored capture, never removes a cited snapshot, recovers a full
// history, and reads only the latest record per check.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchSource, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createCheckRunner, createLookoutSnapshotStore, type CheckResult, type SnapshotRetention } from "../src/index.js";
import { memoryStore, source } from "./helpers.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-retention-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function recordFiles(root: string): Promise<string[]> {
  const [sourceDirectory] = await readdir(root);
  const directory = path.join(root, sourceDirectory!);
  return (await readdir(directory)).filter((name) => name.endsWith(".json")).map((name) => path.join(directory, name));
}

let tick = 0;
function runnerFor(store: Parameters<typeof createCheckRunner>[0]["store"], page: { body: string }, retention?: SnapshotRetention) {
  return createCheckRunner({
    store,
    ...(retention === undefined ? {} : { retention }),
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0 }, {
      ...options,
      clock: () => new Date(Date.UTC(2026, 8, 1) + ++tick * 60_000).toISOString(),
      fetch: async () => new Response(page.body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    }),
  });
}

function currentRef(result: CheckResult): string {
  if (result.kind !== "changed") assert.fail(`expected a changed capture, got ${JSON.stringify(result)}`);
  return result.currentSnapshotRef;
}

test("keepLast 3 over 10 changed captures leaves the newest 3 plus every cited snapshot", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const cited: string[] = [];
    const page = { body: "" };
    const runner = runnerFor(store, page, { keepLast: 3, cited: () => cited });
    const refs: string[] = [];
    for (let capture = 1; capture <= 10; capture += 1) {
      page.body = `capture ${capture}`;
      const result = await runner.check(source());
      assert.deepEqual(result.warnings, []);
      refs.push(currentRef(result));
      // An observation recorded for capture 2 cites it from then on.
      if (capture === 2) cited.push(refs[1]!);
    }
    assert.equal((await recordFiles(root)).length, 4);
    const remaining = await Promise.all(refs.map(async (ref) => (await resolveSnapshotSourceRef(store, ref)).ok));
    assert.deepEqual(remaining, [false, true, false, false, false, false, false, true, true, true]);
  });
});

test("without retention every changed capture is kept", async () => {
  await withRoot(async (root) => {
    const page = { body: "" };
    const runner = runnerFor(createLookoutSnapshotStore(root), page);
    for (let capture = 1; capture <= 5; capture += 1) {
      page.body = `capture ${capture}`;
      currentRef(await runner.check(source()));
    }
    assert.equal((await recordFiles(root)).length, 5);
  });
});

test("the prior capture a result names survives pruning even with keepLast 0", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const page = { body: "one" };
    const runner = runnerFor(store, page, { keepLast: 0, cited: () => [] });
    currentRef(await runner.check(source()));
    page.body = "two";
    const second = await runner.check(source());
    assert.equal(second.kind, "changed");
    if (second.kind !== "changed") return;
    assert.equal((await resolveSnapshotSourceRef(store, second.priorSnapshotRef!)).ok, true);
  });
});

test("a check reads only the latest record: older records are never opened", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const page = { body: "" };
    const runner = runnerFor(store, page);
    for (let capture = 1; capture <= 10; capture += 1) {
      page.body = `capture ${capture}`;
      currentRef(await runner.check(source()));
    }
    // Corrupt every record but the newest. A check that read history would
    // fail its prior read on the first of these.
    const files = (await recordFiles(root)).sort();
    for (const file of files.slice(0, -1)) await writeFile(file, "not a snapshot record");
    page.body = "capture 11";
    const result = await runner.check(source());
    assert.equal(result.kind, "changed", JSON.stringify(result));
  });
});

test("a full history is recovered by pruning once and retrying the capture", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root, { maxHistoryFiles: 3 });
    const page = { body: "" };
    const unbounded = runnerFor(store, page);
    for (let capture = 1; capture <= 3; capture += 1) {
      page.body = `capture ${capture}`;
      currentRef(await unbounded.check(source()));
    }
    page.body = "capture 4";
    const full = await unbounded.check(source());
    assert.equal(full.kind === "error" && full.error.kind, "history-full");

    const bounded = runnerFor(store, page, { keepLast: 1, cited: () => [] });
    const recovered = await bounded.check(source());
    assert.equal(recovered.kind, "changed", JSON.stringify(recovered));
    assert.equal((await recordFiles(root)).length, 2);
  });
});

test("nothing is pruned when the cited set cannot be read, and the check still succeeds with a warning", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const page = { body: "" };
    const runner = runnerFor(store, page, { keepLast: 1, cited: () => { throw new Error("observation store offline"); } });
    let last: CheckResult | undefined;
    for (let capture = 1; capture <= 3; capture += 1) {
      page.body = `capture ${capture}`;
      last = await runner.check(source());
    }
    assert.equal(last?.kind, "changed");
    assert.match(last!.warnings.join("\n"), /retention skipped: cited references could not be read: observation store offline/);
    assert.equal((await recordFiles(root)).length, 3);

    const invalid = runnerFor(store, page, { keepLast: 1, cited: () => ["not-a-reference"] });
    page.body = "capture 4";
    const result = await invalid.check(source());
    assert.match(result.warnings.join("\n"), /retention skipped: a cited reference is not a snapshot reference/);
    assert.equal((await recordFiles(root)).length, 4);
  });
});

test("a store without prune stores the capture and warns", async () => {
  const page = { body: "only" };
  const result = await runnerFor(memoryStore(), page, { keepLast: 1, cited: () => [] }).check(source());
  assert.equal(result.kind, "changed");
  assert.deepEqual(result.warnings, ["snapshot retention skipped: the store cannot prune"]);
});

test("invalid retention is refused when the runner is created", () => {
  const store = memoryStore();
  for (const keepLast of [-1, 1.5, Number.NaN]) {
    assert.throws(() => createCheckRunner({ store, retention: { keepLast, cited: () => [] } }), TypeError);
  }
});
