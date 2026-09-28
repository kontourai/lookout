// Checks of an unchanged page do not grow snapshot history, and the Forage
// history ceiling is configurable through Lookout's store wrapper.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchSource, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createCheckRunner, createLookoutSnapshotStore } from "../src/index.js";
import { source } from "./helpers.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-repeat-capture-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function recordCount(root: string): Promise<number> {
  const [sourceDirectory] = await readdir(root);
  return (await readdir(path.join(root, sourceDirectory!))).filter((name) => name.endsWith(".json")).length;
}

function runnerFor(store: ReturnType<typeof createLookoutSnapshotStore>, page: { body: string; etag?: string }) {
  let tick = 0;
  return createCheckRunner({
    store,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0 }, {
      ...options,
      clock: () => new Date(Date.UTC(2026, 8, 1) + ++tick * 60_000).toISOString(),
      // A new Date header on every response, as real servers send.
      fetch: async () => new Response(page.body, {
        status: 200,
        headers: { date: new Date(Date.UTC(2026, 8, 1) + tick * 60_000).toUTCString(), ...(page.etag ? { etag: page.etag } : {}) },
      }),
    }),
  });
}

test("50 checks of an unchanged page leave one snapshot record", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const runner = runnerFor(store, { body: "stable page" });
    const kinds = new Set<string>();
    let lastRef: string | undefined;
    for (let check = 0; check < 50; check += 1) {
      const result = await runner.check(source());
      kinds.add(result.kind);
      if (result.kind === "unchanged-hash") lastRef = result.currentSnapshotRef;
    }
    assert.deepEqual([...kinds], ["changed", "unchanged-hash"]);
    assert.equal(await recordCount(root), 1);
    const replay = await resolveSnapshotSourceRef(store, lastRef!);
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.snapshot.body, "stable page");
  });
});

test("a changed body or a changed validator is still appended", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root);
    const page: { body: string; etag?: string } = { body: "one", etag: '"a"' };
    const runner = runnerFor(store, page);
    await runner.check(source());
    // Same body, new validator: a later conditional request needs the new etag.
    page.etag = '"b"';
    assert.equal((await runner.check(source())).kind, "unchanged-hash");
    page.body = "two";
    assert.equal((await runner.check(source())).kind, "changed");
    assert.equal(await recordCount(root), 3);
  });
});

test("the Forage history ceiling is passed through, and a full history is a typed history-full error", async () => {
  await withRoot(async (root) => {
    const store = createLookoutSnapshotStore(root, { maxHistoryFiles: 2 });
    const page = { body: "first" };
    const runner = runnerFor(store, page);
    for (const body of ["first", "second"]) {
      page.body = body;
      assert.equal((await runner.check(source())).kind, "changed");
    }
    page.body = "third";
    const full = await runner.check(source());
    assert.equal(full.kind, "error");
    assert.equal(full.kind === "error" && full.origin, "lookout");
    if (full.kind === "error") {
      assert.equal(full.error.kind, "history-full");
      assert.match(full.error.message, /maximum of 2 records; configure snapshot retention/);
    }
  });
});
