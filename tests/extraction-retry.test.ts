// A change that acquisition persisted but extraction never handled is
// extracted on the next check, even though acquisition now reports the page as
// unchanged. Real check runner, real Forage fetch and in-memory store.

import assert from "node:assert/strict";
import test from "node:test";
import { createInMemorySnapshotStore } from "@kontourai/forage";
import { fetchSource } from "@kontourai/forage/fetch";
import { createPreparedArtifact, type ExtractionResult } from "@kontourai/traverse";
import {
  createCheckRunner,
  createObserveExtractDiff,
  extractedSnapshotRef,
  type ObserveExtractObservation,
  type ObserveExtractRecorder,
} from "../src/index.js";
import { source } from "./helpers.js";

function harness() {
  const store = createInMemorySnapshotStore();
  const page = { body: "v1" };
  let tick = 0;
  const runner = createCheckRunner({
    store,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0 }, {
      ...options,
      clock: () => `2026-09-01T00:00:${String(++tick).padStart(2, "0")}.000Z`,
      fetch: async () => new Response(page.body, { status: 200 }),
    }),
  });
  const provider = { calls: 0, failures: 0 };
  const records: ObserveExtractObservation[] = [];
  const recorder: ObserveExtractRecorder = {
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
  };
  const observe = createObserveExtractDiff({
    acquisition: runner,
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
    recorder,
  });
  async function step(body: string, failures = 0) {
    page.body = body;
    provider.failures = failures;
    const result = await observe.observe(source());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("observe failed");
    return { check: result.value.check.kind, outcome: result.value.outcome, calls: provider.calls, value: result.value };
  }
  return { step, records };
}

test("a change whose extraction failed is extracted on the next check, then skipped once handled", async () => {
  const { step } = harness();
  const initial = await step("v1");
  const failed = await step("v2", 1);
  const retried = await step("v2");
  const settled = await step("v2");

  assert.deepEqual(
    [initial, failed, retried, settled].map(({ check, outcome, calls }) => [check, outcome, calls]),
    [
      ["changed", "completed", 1],
      ["changed", "extraction-failure", 2],
      ["unchanged-hash", "completed", 3],
      ["unchanged-hash", "unchanged", 3],
    ],
  );
  // The retry is compared with the last snapshot that was extracted.
  assert.equal(retried.value.sourceSnapshot?.priorSnapshotRef, initial.value.sourceSnapshot?.currentSnapshotRef);
  assert.equal(retried.value.proposalSet?.snapshotRef, retried.value.sourceSnapshot?.currentSnapshotRef);
});

test("a successful extraction followed by identical bytes still skips extraction", async () => {
  const { step } = harness();
  await step("v1");
  const again = await step("v1");
  assert.deepEqual([again.check, again.outcome, again.calls], ["unchanged-hash", "unchanged", 1]);
});

test("an extraction that fails twice in a row is retried on the third check", async () => {
  const { step } = harness();
  await step("v1");
  const first = await step("v2", 1);
  const second = await step("v2", 1);
  const third = await step("v2");
  assert.deepEqual(
    [first, second, third].map(({ outcome, calls }) => [outcome, calls]),
    [["extraction-failure", 2], ["extraction-failure", 3], ["completed", 4]],
  );
});

test("a source whose first extraction failed is extracted on the next unchanged check", async () => {
  const { step } = harness();
  const failed = await step("v1", 1);
  const retried = await step("v1");
  assert.deepEqual([failed.outcome, retried.check, retried.outcome, retried.calls], ["extraction-failure", "unchanged-hash", "completed", 2]);
  assert.equal(retried.value.sourceSnapshot?.priorSnapshotRef, null);
});

test("a recorder that cannot report its last extracted snapshot fails the observation without extracting", async () => {
  let extracted = 0;
  const unchanged = { kind: "unchanged-304" as const, sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], snapshotRef: "snapshot-prior" };
  const run = (lastExtractedSnapshotRef: () => Promise<unknown>) => createObserveExtractDiff({
    acquisition: { async check() { return unchanged; } },
    extraction: { async extract() { extracted += 1; throw new Error("not reached"); } },
    recorder: {
      async record() { return { observationId: "observation-1", priorObservationId: null }; },
      lastExtractedSnapshotRef: lastExtractedSnapshotRef as () => Promise<string | null>,
    },
  }).observe(source());

  const threw = await run(async () => { throw new Error("store offline"); });
  assert.equal(threw.ok, false);
  if (!threw.ok) assert.equal(threw.error.kind, "recording-failed");

  const invalid = await run(async () => 42);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.kind, "dependency-contract");
  assert.equal(extracted, 0);
});
