// The same bytes under another declared charset decode to other text, so they
// are a new capture and are extracted again. Real check runner, real Forage
// fetch, in-memory store.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInMemorySnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef, fetchSource } from "@kontourai/forage/fetch";
import { createPreparedArtifact, type ExtractionResult } from "@kontourai/traverse";
import {
  createCheckRunner,
  createObserveExtractDiff,
  extractedSnapshotRef,
  type ObserveExtractObservation,
} from "../src/index.js";
import { source } from "./helpers.js";

// "café" in UTF-8. Under ISO-8859-1 the same bytes read "cafÃ©".
const BYTES = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);

function harness() {
  const store = createInMemorySnapshotStore();
  const page = { contentType: "text/html; charset=utf-8" };
  let tick = 0;
  const runner = createCheckRunner({
    store,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0 }, {
      ...options,
      clock: () => `2026-09-01T00:00:${String(++tick).padStart(2, "0")}.000Z`,
      fetch: async () => new Response(BYTES, { status: 200, headers: { "content-type": page.contentType } }),
    }),
  });
  const provider = { calls: 0, failures: 0, texts: [] as string[] };
  const records: ObserveExtractObservation[] = [];
  const observe = createObserveExtractDiff({
    acquisition: runner,
    snapshots: store,
    extraction: {
      async extract({ snapshotRef }): Promise<ExtractionResult> {
        provider.calls += 1;
        if (provider.failures > 0) {
          provider.failures -= 1;
          throw new Error("rate limited");
        }
        return {
          proposals: [],
          raw: { response: "", model: "example" },
          extractedAt: "2026-09-01T01:00:00.000Z",
          providerCalls: 1,
          totalTokensUsed: 1,
          preparedArtifact: createPreparedArtifact(`text for ${snapshotRef}`, { preparationMode: "text", sourceSnapshotRef: snapshotRef }),
        };
      },
    },
    recorder: {
      async record(observation) {
        records.push(observation);
        return { observationId: `observation-${records.length}`, priorObservationId: null };
      },
      async lastExtractedSnapshotRef() {
        for (const observation of [...records].reverse()) {
          const extracted = extractedSnapshotRef(observation);
          if (extracted !== null) return extracted;
        }
        return null;
      },
    },
  });
  async function step(contentType: string, failures = 0) {
    page.contentType = contentType;
    provider.failures = failures;
    const result = await observe.observe(source());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("observe failed");
    return [result.value.check.kind, result.value.outcome, provider.calls, (await store.list("source-a")).length];
  }
  return { step, store, runner };
}

test("the same bytes under another declared charset are a new capture and are extracted", async () => {
  const { step } = harness();
  assert.deepEqual(await step("text/html; charset=utf-8"), ["changed", "completed", 1, 1]);
  assert.deepEqual(await step("text/html; charset=utf-8"), ["unchanged-hash", "unchanged", 1, 1]);
  assert.deepEqual(await step("text/html; charset=iso-8859-1"), ["unchanged-hash", "completed", 2, 2]);
  assert.deepEqual(await step("text/html; charset=iso-8859-1"), ["unchanged-hash", "unchanged", 2, 2]);
});

test("a charset change whose extraction failed is extracted on the next check", async () => {
  const { step } = harness();
  await step("text/html; charset=utf-8");
  assert.deepEqual(await step("text/html; charset=iso-8859-1", 1), ["unchanged-hash", "extraction-failure", 2, 2]);
  // The capture now repeats, but it still differs from the last extracted one.
  assert.deepEqual(await step("text/html; charset=iso-8859-1"), ["unchanged-hash", "completed", 3, 2]);
  assert.deepEqual(await step("text/html; charset=iso-8859-1"), ["unchanged-hash", "unchanged", 3, 2]);
});

test("a charset label that decodes the same way is not a new capture", async () => {
  const { step } = harness();
  await step("text/html; charset=utf-8");
  assert.deepEqual(await step("text/html; charset=UTF8"), ["unchanged-hash", "unchanged", 1, 1]);
  assert.deepEqual(await step("text/html"), ["unchanged-hash", "unchanged", 1, 1]);
});

test("a capture stored by an earlier Forage release repeats instead of appending", async () => {
  const store = createInMemorySnapshotStore();
  // The earlier record format: decoded UTF-8 text, hashed as that text, no bytes or charset.
  const legacy = {
    sourceId: "source-a",
    url: "https://example.test/source-a",
    status: 200,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    body: "café",
    bodyHash: createHash("sha256").update("café", "utf8").digest("hex"),
    headers: { "content-type": "text/html; charset=utf-8" },
  };
  await store.put(legacy);
  const runner = createCheckRunner({
    store,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0 }, {
      ...options,
      clock: () => "2026-09-01T00:00:00.000Z",
      fetch: async () => new Response(BYTES, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    }),
  });
  const result = await runner.check(source());
  assert.equal(result.kind, "unchanged-hash");
  if (result.kind === "unchanged-hash") assert.equal(result.currentSnapshotRef, buildSnapshotSourceRef(legacy));
  assert.equal((await store.list("source-a")).length, 1);
});
