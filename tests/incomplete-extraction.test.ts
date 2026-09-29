import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createInMemorySnapshotStore, type ExactSnapshotStore, type Snapshot } from "@kontourai/forage";
import { createPreparedArtifact, type ExtractionCoverageEntry, type ExtractionProposal, type ExtractionResult } from "@kontourai/traverse";
import {
  buildSemanticReviewWork,
  createDriftEmitter,
  createObservationStore,
  createObserveExtractDiff,
  diffProposalSets,
  extractedSnapshotRef,
  type ObserveExtractObservation,
  type ProposalSetIncompleteness,
  type ProposalSetObservation,
  type SemanticReviewChange,
} from "../src/index.js";
import { source } from "./helpers.js";

// A run that did not read all of its text must never read as complete: the
// incompleteness reaches the observation and drift, and a proposal the prior
// had that the incomplete run lacks is unobserved, never "removed".

const proposal = (fieldPath: string, index: number, value: unknown): ExtractionProposal => ({
  fieldPath, pathIndices: [index], candidateValue: value, confidence: 0.9,
  provenance: { locator: `chars:${index * 10}-${index * 10 + 5}`, excerpt: String(value) }, extractor: "example-extractor:v1",
});
const coverage: ExtractionCoverageEntry[] = [
  { chunk: 1, start: 0, end: 10, status: "complete" },
  { chunk: 2, start: 10, end: 20, status: "unread", reason: "provider-failure" },
];
const lostChunk: ProposalSetIncompleteness = { reason: "provider-failure", coverage };

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const callbacks = {
  selectEntities(input: ProposalSetObservation): readonly Entity[] {
    const grouped = new Map<number, ExtractionProposal[]>();
    for (const item of input.proposals) { const i = item.pathIndices?.[0] ?? -1; grouped.set(i, [...(grouped.get(i) ?? []), item]); }
    return [...grouped].map(([i, proposals]) => ({ key: `entry-${i}`, proposals }));
  },
  entityIdentity: (entity: Entity) => entity.key,
  proposalsFor: (entity: Entity) => entity.proposals,
  fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
};
const plain = (snapshotRef: string, proposals: readonly ExtractionProposal[], incomplete?: ProposalSetIncompleteness): ProposalSetObservation =>
  ({ sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-time`, proposals, ...(incomplete ? { incomplete } : {}) });

// Prior saw entry 0 (two fields) and entry 1; the current run saw only entry 0's name.
const priorProposals = [proposal("name", 0, "first"), proposal("price", 0, "10"), proposal("name", 1, "second")];
const currentProposals = [proposal("name", 0, "first")];

describe("proposal diff against an incomplete current observation", () => {
  test("control: a complete current observation reports the missing field and entity as removed", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", priorProposals), current: plain("snapshot-2", currentProposals), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.value.events.length, 1);
    assert.deepEqual(result.value.facts.removedEntities, ["entry-1"]);
    assert.equal(result.value.facts.removedProposalEvidence?.length, 2);
    assert.equal(result.value.facts.unobservedEntities, undefined);
  });

  test("reports nothing as removed and lists what it could not see as unobserved", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", priorProposals), current: plain("snapshot-2", currentProposals, lostChunk), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.events, []);
    assert.deepEqual(result.value.facts.removedEntities, []);
    assert.deepEqual(result.value.facts.removedProposalOccurrences, []);
    assert.deepEqual(result.value.facts.removedProposalEvidence, []);
    assert.deepEqual(result.value.facts.unobservedEntities, ["entry-1"]);
    assert.deepEqual(result.value.facts.unobservedProposalOccurrences?.map((item) => `${item.fieldPath}#${item.pathIndices?.[0]}`).sort(), ["name#1", "price#0"]);
    assert.deepEqual(result.value.facts.unobservedProposalEvidence?.map((item) => `${item.entityKey}/${item.fieldKey}`).sort(), ["entry-0/price", "entry-1/name"]);
  });

  test("still reports what the incomplete run did see change", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", priorProposals), current: plain("snapshot-2", [proposal("name", 0, "renamed")], lostChunk), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.events.map((event) => event.kind === "field-changed" ? `${event.fieldKey}:${event.changeKind}` : event.kind), ["name:value-updated"]);
  });
});

describe("drift emission", () => {
  const snapshots = new Map<string, Snapshot>();
  const admissionStore: ExactSnapshotStore = {
    async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; },
    async findExact(reference) {
      const found = snapshots.get(`${reference.sourceId}:${reference.bodyHash}:${reference.fetchedAt}`);
      return found ? { kind: "found", snapshot: found } : { kind: "missing" };
    },
  };
  const observation = (label: string, second: number, proposals: readonly ExtractionProposal[], incomplete?: ProposalSetIncompleteness): ProposalSetObservation => {
    const body = `body:${label}`;
    const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:00:${String(second).padStart(2, "0")}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
    snapshots.set(`${snapshot.sourceId}:${snapshot.bodyHash}:${snapshot.fetchedAt}`, snapshot);
    return { sourceId: "source-a", snapshotRef: buildSnapshotSourceRef(snapshot), observedAt: `${label}-time`, proposals, ...(incomplete ? { incomplete } : {}) };
  };
  const anchor = (current: ProposalSetObservation, checkedAt: string) => ({ checkedAt, resultKind: "changed" as const, currentSnapshotRef: current.snapshotRef });

  test("an incomplete baseline says so", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-incomplete-"));
    try {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
      const first = observation("incomplete-baseline", 3, currentProposals, lostChunk);
      const result = await emitter.emit({ source: source(), current: first, check: anchor(first, "one"), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return assert.fail("expected success");
      const fact = result.value.facts[0];
      assert.equal(fact?.kind, "baseline-established");
      assert.deepEqual(fact?.incomplete, lostChunk);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("an incomplete current run emits no removal and carries its incompleteness and unobserved facts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-incomplete-"));
    try {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
      const first = observation("complete-prior", 4, priorProposals);
      assert.equal((await emitter.emit({ source: source(), current: first, check: anchor(first, "one") , callbacks })).ok, true);
      const second = observation("incomplete-current", 5, currentProposals, lostChunk);
      const result = await emitter.emit({ source: source(), current: second, check: anchor(second, "two"), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return assert.fail("expected success");
      assert.deepEqual(result.value.events, []);
      const fact = result.value.facts[0];
      assert.equal(fact?.kind, "proposal-set-facts"); if (fact?.kind !== "proposal-set-facts") return;
      assert.deepEqual(fact.incomplete, lostChunk);
      assert.deepEqual(fact.value.removedEntities, []);
      assert.deepEqual(fact.value.removedProposalEvidence, []);
      assert.deepEqual(fact.value.unobservedEntities, ["entry-1"]);
      assert.equal(fact.value.unobservedProposalEvidence?.length, 2);
      assert.equal(fact.value.unobservedProposalOccurrences?.length, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("baseline continuity through the real store and emitter", () => {
  const snapshots = new Map<string, Snapshot>();
  const admissionStore: ExactSnapshotStore = {
    async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; },
    async findExact(reference) {
      const found = snapshots.get(`${reference.sourceId}:${reference.bodyHash}:${reference.fetchedAt}`);
      return found ? { kind: "found", snapshot: found } : { kind: "missing" };
    },
  };
  const observation = (label: string, second: number, proposals: readonly ExtractionProposal[], incomplete?: ProposalSetIncompleteness): ProposalSetObservation => {
    const body = `body:${label}`;
    const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:01:${String(second).padStart(2, "0")}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
    snapshots.set(`${snapshot.sourceId}:${snapshot.bodyHash}:${snapshot.fetchedAt}`, snapshot);
    return { sourceId: "source-a", snapshotRef: buildSnapshotSourceRef(snapshot), observedAt: `${label}-time`, proposals, ...(incomplete ? { incomplete } : {}) };
  };
  const anchor = (current: ProposalSetObservation) => ({ checkedAt: `${current.observedAt}-checked`, resultKind: "changed" as const, currentSnapshotRef: current.snapshotRef });
  const eventKeys = (events: readonly import("../src/index.js").ProposalDiffEvent[]) => events.map((event) => event.kind === "field-changed" ? `${event.entityKey}/${event.fieldKey}:${event.changeKind}` : `${event.entityKey}:${event.kind}`);

  test("complete, then incomplete, then complete: no false population and the real removal is reported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-incomplete-"));
    try {
      const store = createObservationStore({ root });
      const emitter = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
      // A: entry 0 has name and price, entry 1 exists.
      const a = observation("sequence-a", 1, priorProposals);
      const first = await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks });
      assert.equal(first.ok, true); if (!first.ok) return;
      // B: a chunk was lost; only entry 0's name was read.
      const b = observation("sequence-b", 2, currentProposals, lostChunk);
      const second = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(second.ok, true); if (!second.ok) return;
      assert.deepEqual(second.value.events, []);
      assert.equal(second.value.committedObservation, null);
      const head = await store.loadLatest("source-a");
      assert.equal(head.ok && head.value?.observationId, first.value.committedObservation?.observationId);
      // C: complete again; entry 0's price was there all along and entry 1 is really gone.
      const c = observation("sequence-c", 3, [proposal("name", 0, "first"), proposal("price", 0, "10")]);
      const third = await emitter.emit({ source: source(), current: c, check: anchor(c), callbacks });
      assert.equal(third.ok, true); if (!third.ok) return;
      assert.equal(third.value.priorObservationId, first.value.committedObservation?.observationId);
      assert.deepEqual(eventKeys(third.value.events), []);
      const fact = third.value.facts[0];
      assert.equal(fact?.kind, "proposal-set-facts"); if (fact?.kind !== "proposal-set-facts") return;
      assert.deepEqual(fact.value.removedEntities, ["entry-1"]);
      assert.deepEqual(fact.value.removedProposalEvidence?.map((item) => `${item.entityKey}/${item.fieldKey}`), ["entry-1/name"]);
      assert.notEqual(third.value.committedObservation, null);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("an incomplete first baseline is stored with its marker, and what it missed is newly observed, not added", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-incomplete-"));
    try {
      const store = createObservationStore({ root });
      const emitter = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
      const a = observation("partial-first", 4, currentProposals, lostChunk);
      const first = await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks });
      assert.equal(first.ok, true); if (!first.ok) return;
      const stored = await store.loadLatest("source-a");
      assert.equal(stored.ok, true); if (!stored.ok) return;
      assert.deepEqual(stored.value?.incomplete, lostChunk);
      const c = observation("complete-next", 5, priorProposals);
      const next = await emitter.emit({ source: source(), current: c, check: anchor(c), callbacks });
      assert.equal(next.ok, true); if (!next.ok) return;
      assert.deepEqual(eventKeys(next.value.events), []);
      const fact = next.value.facts[0];
      assert.equal(fact?.kind, "proposal-set-facts"); if (fact?.kind !== "proposal-set-facts") return;
      assert.deepEqual(fact.priorIncomplete, lostChunk);
      assert.deepEqual(fact.value.addedProposalEvidence, []);
      assert.deepEqual(fact.value.newlyObservedEntities, ["entry-1"]);
      assert.deepEqual(fact.value.newlyObservedProposalEvidence?.map((item) => `${item.entityKey}/${item.fieldKey}`), ["entry-0/price", "entry-1/name"]);
      // A complete run replaces an incomplete baseline.
      const head = await store.loadLatest("source-a");
      assert.equal(head.ok && head.value?.incomplete, undefined);
      assert.equal(head.ok && head.value?.observationId, next.value.committedObservation?.observationId);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("the stored marker is digest-covered and a malformed one is refused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-incomplete-"));
    try {
      const store = createObservationStore({ root });
      const record = (incomplete: unknown) => ({ observation: { sourceId: "source-a", snapshotRef: "snapshot-1", observedAt: "observed", proposals: currentProposals, incomplete: incomplete as ProposalSetIncompleteness }, recordedAt: "recorded", check: { checkedAt: "checked", resultKind: "changed" as const, currentSnapshotRef: "snapshot-1" } });
      const malformed = await store.commit(record({ reason: "" }), null);
      assert.equal(malformed.ok, false);
      const committed = await store.commit(record(lostChunk), null);
      assert.equal(committed.ok, true); if (!committed.ok) return;
      const file = path.join(root, committed.value.sourceKey, `${committed.value.observationId}.json`);
      const { readFile, writeFile } = await import("node:fs/promises");
      await writeFile(file, (await readFile(file, "utf8")).replace("provider-failure", "content-truncated"));
      const tampered = await store.loadLatest("source-a");
      assert.equal(tampered.ok, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("what counts as extracted", () => {
  const observed = (partial: Record<string, unknown> | undefined, entries: readonly ExtractionCoverageEntry[]): ObserveExtractObservation => ({
    source: { id: "source-a", url: "https://example.test/source-a", kind: "web-page" },
    check: { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" },
    outcome: partial === undefined ? "completed" : "partial",
    sourceSnapshot: { priorSnapshotRef: null, currentSnapshotRef: "snapshot-current" },
    preparedArtifact: null, proposalSet: null,
    attempt: { extractedAt: "at", providerCalls: 2, totalTokensUsed: 1, ...(partial ? { partial: { completedChunks: 2, remainingChunks: 0, ...partial } as never } : {}), coverage: entries },
  });
  const done = { chunk: 1, start: 0, end: 10, status: "complete" as const };
  const cut = { chunk: 2, start: 10, end: 20, status: "unread" as const, reason: "content-truncated" as const };
  const capped = { chunk: 2, start: 10, end: 20, status: "output-truncated" as const };
  const unusable = { chunk: 2, start: 10, end: 20, status: "unread" as const, reason: "missing-tool-call" as const };

  test("a content cut repeats on the same capture, so it counts as extracted", () => {
    assert.equal(extractedSnapshotRef(observed({ reason: "content-truncated" }, [done, cut])), "snapshot-current");
  });
  for (const [label, partial, entries] of [
    ["an answer cut at the output cap", { reason: "output-truncated" }, [done, capped]],
    ["an unusable answer", { reason: "provider-failure" }, [done, unusable]],
    ["a token budget stop", { reason: "max-total-tokens" }, [done, { ...cut, reason: "not-dispatched" as const }]],
    ["a content cut alongside an output-cap loss", { reason: "content-truncated" }, [done, cut, { ...capped, chunk: 3, start: 20, end: 30 }]],
  ] as const) {
    test(`${label} is extracted again on the next check`, () => {
      assert.equal(extractedSnapshotRef(observed(partial, entries)), null);
    });
  }
});

describe("semantic review work", () => {
  const schema = [{ path: "name", type: "string" as const }, { path: "price", type: "string" as const }];
  const project = (current: ProposalSetObservation) => buildSemanticReviewWork({
    prior: plain("snapshot-1", priorProposals), current,
    observationIdentity: { prior: "observation-prior", current: "observation-current" },
    ...callbacks, schema,
    claimTarget: (change: SemanticReviewChange) => ({ subjectType: "record", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
  });
  const kinds = (result: ReturnType<typeof project>) => result.ok ? result.value.items.map((item) => item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind).sort() : assert.fail("projection failed");

  test("control: a complete run lacking a field yields removal and coverage-gap work", () => {
    assert.deepEqual(kinds(project(plain("snapshot-2", currentProposals))), ["coverage-gap", "proposal-removed", "proposal-removed"]);
  });

  test("an incomplete run yields neither removal nor coverage-gap work", () => {
    assert.deepEqual(kinds(project(plain("snapshot-2", currentProposals, lostChunk))), []);
  });
});

describe("observe-extract-diff", () => {
  const recorder = () => ({ records: [] as unknown[], async record(observation: unknown) { this.records.push(observation); return { observationId: `observation-${this.records.length}`, priorObservationId: null }; }, async lastExtractedSnapshotRef() { return null; } });
  const observe = async (overrides: Partial<ExtractionResult>) => {
    const composition = createObserveExtractDiff({ snapshots: createInMemorySnapshotStore(),
      acquisition: { async check() { return { kind: "changed", sourceId: "source-a", sourceUrl: "https://example.test/source-a", checkedAt: "checked", warnings: [], priorSnapshotRef: null, currentSnapshotRef: "snapshot-current", changeBasis: "initial" }; } },
      extraction: { async extract() {
        return { proposals: currentProposals, raw: { response: "", model: "example" }, extractedAt: "2026-07-20T12:00:00.000Z", providerCalls: 2, totalTokensUsed: 7,
          preparedArtifact: createPreparedArtifact("hello world, twenty", { preparationMode: "text", sourceSnapshotRef: "snapshot-current" }), ...overrides };
      } },
      recorder: recorder(),
    });
    const result = await composition.observe(source());
    assert.equal(result.ok, true); if (!result.ok) return assert.fail("expected success");
    return result.value;
  };
  const failure = { kind: "network" as const, retryable: true, message: "unavailable", provider: "example" };

  test("a complete run has coverage on the attempt and no incompleteness on its proposal set", async () => {
    const complete = [{ chunk: 1, start: 0, end: 20, status: "complete" as const }];
    const value = await observe({ coverage: complete });
    assert.equal(value.outcome, "completed");
    assert.deepEqual(value.attempt?.coverage, complete);
    assert.equal(value.proposalSet !== null && Object.hasOwn(value.proposalSet, "incomplete"), false);
  });

  for (const [label, overrides, outcome, reason] of [
    ["content truncation", { partial: { reason: "content-truncated", completedChunks: 2, remainingChunks: 0 }, coverage }, "partial", "content-truncated"],
    ["output truncation", { partial: { reason: "output-truncated", completedChunks: 2, remainingChunks: 0 }, coverage }, "partial", "output-truncated"],
    ["a lost chunk", { partial: { reason: "provider-failure", completedChunks: 2, remainingChunks: 0 }, coverage, providerFailures: [failure] }, "partial-provider-failure", "provider-failure"],
    ["a run where no chunk was answered", { proposals: [], error: "unavailable", coverage, providerFailures: [failure] }, "provider-failure", "provider-failure"],
    ["a failed run without provider failures", { proposals: [], error: "no usable answer", coverage }, "extraction-failure", "extraction-error"],
  ] as const) {
    test(`${label} reaches the proposal set as incompleteness with its coverage`, async () => {
      const value = await observe(overrides as Partial<ExtractionResult>);
      assert.equal(value.outcome, outcome);
      assert.deepEqual(value.attempt?.coverage, coverage);
      assert.deepEqual(value.proposalSet?.incomplete, { reason, coverage });
    });
  }
});
