import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtractionProposal,
  ExtractionResult,
  PreparedArtifact,
} from "@kontourai/traverse";
import { createPreparedArtifact } from "@kontourai/traverse";
import { createObserveExtractDiff, type ObserveExtractObservation, type ObserveExtractRecorder } from "../src/index.js";
import { source } from "./helpers.js";

const artifactFor = (snapshotRef: string): PreparedArtifact => createPreparedArtifact("hello world", {
  preparationMode: "text",
  sourceSnapshotRef: snapshotRef,
});
const artifact = artifactFor("snapshot-current");

const proposal = (value = "value"): ExtractionProposal => ({
  fieldPath: "title",
  candidateValue: value,
  confidence: 0.9,
  provenance: { locator: "chars:0-5", excerpt: value },
  extractor: "example-extractor:v1",
});

function extraction(overrides: Partial<ExtractionResult> = {}, snapshotRef = "snapshot-current"): ExtractionResult {
  return {
    proposals: [proposal()],
    raw: { response: "", model: "example" },
    extractedAt: "2026-07-20T12:00:00.000Z",
    providerCalls: 1,
    totalTokensUsed: 7,
    preparedArtifact: artifactFor(snapshotRef),
    ...overrides,
  };
}

function recorder(): ObserveExtractRecorder & { records: ObserveExtractObservation[] } {
  const records: ObserveExtractObservation[] = [];
  return {
    records,
    async record(observation) {
      records.push(observation);
      return { observationId: `observation-${records.length}`, priorObservationId: records.length === 1 ? null : `observation-${records.length - 1}` };
    },
  };
}

test("unchanged checks record an observation without preparation or provider work", async () => {
  const stored = recorder();
  let preparationCalls = 0;
  let providerCalls = 0;
  const composition = createObserveExtractDiff({
    acquisition: { async check() { return { kind: "unchanged-304", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], snapshotRef: "snapshot-prior" }; } },
    extraction: { async extract() { preparationCalls += 1; providerCalls += 1; return extraction(); } },
    recorder: stored,
  });

  const result = await composition.observe(source());
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(preparationCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(stored.records.length, 1);
  assert.equal(result.value.outcome, "unchanged");
  assert.equal(result.value.observationId, "observation-1");
  assert.equal(result.value.priorObservationId, null);
  assert.deepEqual(result.value.sourceSnapshot, { priorSnapshotRef: "snapshot-prior", currentSnapshotRef: "snapshot-prior" });
});

test("a changed source retains the snapshot, prepared artifact, proposal set, and continuity identities", async () => {
  const stored = recorder();
  const composition = createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: "snapshot-prior", currentSnapshotRef: "snapshot-current", changeBasis: "hash" }; } },
    extraction: { async extract() { return extraction(); } },
    recorder: stored,
  });

  const first = await composition.observe(source());
  assert.equal(first.ok, true); if (!first.ok) return;
  assert.equal(first.value.outcome, "completed");
  assert.equal(first.value.preparedArtifact?.ref, artifact.ref);
  assert.equal(first.value.proposalSet?.snapshotRef, "snapshot-current");
  assert.deepEqual(first.value.sourceSnapshot, { priorSnapshotRef: "snapshot-prior", currentSnapshotRef: "snapshot-current" });
  assert.equal(first.value.priorObservationId, null);
  assert.equal(first.value.proposalSet?.proposals.length, 1);

  const second = await composition.observe(source());
  assert.equal(second.ok, true); if (!second.ok) return;
  assert.equal(second.value.observationId, "observation-2");
  assert.equal(second.value.priorObservationId, "observation-1");
});

test("the first changed observation is a baseline record, not fabricated proposal additions or removals", async () => {
  const stored = recorder();
  const composition = createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-first", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({}, "snapshot-first"); } },
    recorder: stored,
  });

  const result = await composition.observe(source());
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.priorObservationId, null);
  assert.equal(result.value.proposalSet?.proposals.length, 1);
  assert.equal("events" in result.value, false);
  assert.equal("additions" in result.value, false);
  assert.equal("removals" in result.value, false);
});

test("partial extraction and provider failure stay as distinct typed observation outcomes", async () => {
  const stored = recorder();
  const partial = createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-partial", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({ partial: { reason: "max-provider-calls", completedChunks: 1, remainingChunks: 2 } }, "snapshot-partial"); } },
    recorder: stored,
  });
  const partialResult = await partial.observe(source());
  assert.equal(partialResult.ok, true); if (!partialResult.ok) return;
  assert.equal(partialResult.value.outcome, "partial");
  assert.equal(partialResult.value.attempt?.partial?.reason, "max-provider-calls");

  const failed = createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-failed", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({ proposals: [], error: "provider unavailable", providerFailures: [{ provider: "example", kind: "unavailable", retryable: true, message: "provider unavailable", native: { status: 503 } }] }, "snapshot-failed"); } },
    recorder: stored,
  });
  const failedResult = await failed.observe(source());
  assert.equal(failedResult.ok, true); if (!failedResult.ok) return;
  assert.equal(failedResult.value.outcome, "provider-failure");
  assert.equal(failedResult.value.attempt?.providerFailures?.[0]?.kind, "unavailable");
  assert.deepEqual(failedResult.value.attempt?.providerFailures, [{ kind: "unavailable", retryable: true }]);
  assert.equal(JSON.stringify(failedResult.value).includes("provider unavailable"), false);
  assert.equal(JSON.stringify(failedResult.value).includes("503"), false);
});

test("a non-fatal provider failure cannot be classified as completed and mixed partial failure is explicit", async () => {
  const changed = (snapshotRef: string) => ({ kind: "changed" as const, sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: snapshotRef, changeBasis: "initial" as const });
  const providerFailure = { provider: "vendor-name", kind: "timeout" as const, retryable: true, message: "token=secret", native: { authorization: "secret" } };

  for (const [snapshotRef, partial, expected] of [
    ["snapshot-provider", undefined, "provider-failure"],
    ["snapshot-mixed", { reason: "max-provider-calls" as const, completedChunks: 1, remainingChunks: 1 }, "partial-provider-failure"],
  ] as const) {
    const result = await createObserveExtractDiff({
      acquisition: { async check() { return changed(snapshotRef); } },
      extraction: { async extract() { return extraction({ providerFailures: [providerFailure], ...(partial === undefined ? {} : { partial }) }, snapshotRef); } },
      recorder: recorder(),
    }).observe(source());
    assert.equal(result.ok, true); if (!result.ok) continue;
    assert.equal(result.value.outcome, expected);
    assert.deepEqual(result.value.attempt?.providerFailures, [{ kind: "timeout", retryable: true }]);
    assert.equal(JSON.stringify(result.value).includes("secret"), false);
    assert.equal(JSON.stringify(result.value).includes("vendor-name"), false);
  }
});

test("rejects acquisition identity and prepared-artifact snapshot mismatches", async () => {
  const stored = recorder();
  const mismatchedCheck = await createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "different", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
    extraction: { async extract() { assert.fail("must not extract"); } },
    recorder: stored,
  }).observe(source());
  assert.equal(mismatchedCheck.ok, false);
  if (!mismatchedCheck.ok) assert.equal(mismatchedCheck.error.kind, "dependency-contract");
  assert.equal(stored.records.length, 0);

  const mismatchedArtifact = await createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({}, "different-snapshot"); } },
    recorder: stored,
  }).observe(source());
  assert.equal(mismatchedArtifact.ok, false);
  if (!mismatchedArtifact.ok) assert.equal(mismatchedArtifact.error.kind, "dependency-contract");
  assert.equal(stored.records.length, 0);

  const invalidArtifact = await createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({ preparedArtifact: { ...artifact, ref: "not-a-ref" as PreparedArtifact["ref"] } }); } },
    recorder: stored,
  }).observe(source());
  assert.equal(invalidArtifact.ok, false);
  if (!invalidArtifact.ok) assert.equal(invalidArtifact.error.kind, "dependency-contract");
});

test("recorder output cannot overwrite the observation and thrown extraction has unknown telemetry", async () => {
  const stored: ObserveExtractRecorder & { seen?: ObserveExtractObservation } = {
    async record(observation) {
      this.seen = observation;
      return { observationId: "observation-1", priorObservationId: null, outcome: "completed", attempt: { providerCalls: 99 } } as never;
    },
  };
  const result = await createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
    extraction: { async extract() { throw new Error("authorization=secret"); } },
    recorder: stored,
  }).observe(source());
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.outcome, "extraction-failure");
  assert.equal(result.value.attempt, null);
  assert.equal(result.value.proposalSet, null);
  assert.equal(JSON.stringify(result.value).includes("secret"), false);
});

test("free-form extraction warnings cannot cross the durable recording boundary", async () => {
  const stored = recorder();
  const result = await createObserveExtractDiff({
    acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
    extraction: { async extract() { return extraction({ warnings: ["authorization=secret-value"] }); } },
    recorder: stored,
  }).observe(source());

  assert.equal(result.ok, true);
  assert.equal(stored.records.length, 1);
  assert.equal(JSON.stringify(stored.records[0]).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(result.ok && result.value.attempt !== null && "warnings" in result.value.attempt, false);
});
