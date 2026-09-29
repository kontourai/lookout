import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ExactSnapshotStore, Snapshot } from "@kontourai/forage";
import type { ExtractionProposal } from "@kontourai/traverse";
import {
  buildSemanticReviewWork,
  createDriftEmitter,
  createObservationStore,
  diffProposalSets,
  type ProposalObservationRecordInput,
  type ProposalSetObservation,
  type SemanticReviewChange,
} from "../src/index.js";
import { source } from "./helpers.js";

// A proposal without confidence is valid, and its absence must survive every
// path as absence: no key at all, never a substituted number.

const withConfidence = (value: unknown, confidence: number): ExtractionProposal => ({
  fieldPath: "entries[].value", pathIndices: [0], candidateValue: value, confidence,
  provenance: { locator: "chars:0-5", excerpt: String(value) }, extractor: "example-extractor:v1",
});
const withoutConfidence = (value: unknown): ExtractionProposal => {
  const proposal = withConfidence(value, 0.5);
  delete proposal.confidence;
  return proposal;
};

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
const plain = (snapshotRef: string, proposals: readonly ExtractionProposal[]): ProposalSetObservation =>
  ({ sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-time`, proposals });

describe("observation store", () => {
  const input = (proposals: readonly unknown[]): ProposalObservationRecordInput => ({
    observation: { sourceId: "source-a", snapshotRef: "snapshot-1", observedAt: "observed", proposals: proposals as ExtractionProposal[] },
    recordedAt: "recorded",
    check: { checkedAt: "checked", resultKind: "changed", currentSnapshotRef: "snapshot-1" },
  });

  test("commits a proposal without confidence and reloads it with no confidence key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-confidence-"));
    try {
      const store = createObservationStore({ root });
      const committed = await store.commit(input([withoutConfidence("value")]), null);
      assert.equal(committed.ok, true, committed.ok ? "" : committed.error.message);
      const loaded = await store.loadLatest("source-a");
      assert.equal(loaded.ok, true); if (!loaded.ok || loaded.value === null) return assert.fail("no observation reloaded");
      assert.equal(loaded.value.proposals.length, 1);
      assert.equal(Object.hasOwn(loaded.value.proposals[0]!, "confidence"), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("still rejects a present confidence that is NaN or a string", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-confidence-"));
    try {
      const store = createObservationStore({ root });
      for (const confidence of [Number.NaN, "0.8", Number.POSITIVE_INFINITY, null]) {
        const committed = await store.commit(input([{ ...withConfidence("value", 0.5), confidence }]), null);
        assert.equal(committed.ok, false, `confidence ${String(confidence)} must be rejected`);
        if (!committed.ok) assert.equal(committed.error.kind, "invalid-input");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("proposal diff", () => {
  test("a value change from a scored to an unscored proposal keeps each side's own confidence", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", [withConfidence("old", 0.8)]), current: plain("snapshot-2", [withoutConfidence("new")]), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    const [event] = result.value.events;
    assert.equal(event?.kind, "field-changed"); if (event?.kind !== "field-changed" || !event.prior || !event.current) return assert.fail("expected a value change");
    assert.equal(event.prior.confidence, 0.8);
    assert.equal(Object.hasOwn(event.current, "confidence"), false);
  });

  test("losing confidence on an unchanged value is reported, not read as unchanged", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", [withConfidence("same", 0.8)]), current: plain("snapshot-2", [withoutConfidence("same")]), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.events, []);
    const changes = result.value.facts.confidenceChanges ?? [];
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.prior.confidence, 0.8);
    assert.equal(Object.hasOwn(changes[0]!.current, "confidence"), false);
  });

  test("a numeric difference between two present scores is not a confidence change", () => {
    const result = diffProposalSets({ prior: plain("snapshot-1", [withConfidence("same", 0.8)]), current: plain("snapshot-2", [withConfidence("same", 0.81)]), ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.facts.confidenceChanges, []);
    assert.deepEqual(result.value.events, []);
  });

  test("identical confidence, present or absent on both sides, is not a confidence change", () => {
    for (const [prior, current] of [[withConfidence("same", 0.8), withConfidence("same", 0.8)], [withoutConfidence("same"), withoutConfidence("same")]] as const) {
      const result = diffProposalSets({ prior: plain("snapshot-1", [prior]), current: plain("snapshot-2", [current]), ...callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.facts.confidenceChanges, []);
    }
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
  const observation = (label: string, second: number, proposals: readonly ExtractionProposal[]): ProposalSetObservation => {
    const body = `body:${label}`;
    const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:00:${String(second).padStart(2, "0")}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
    snapshots.set(`${snapshot.sourceId}:${snapshot.bodyHash}:${snapshot.fetchedAt}`, snapshot);
    return { sourceId: "source-a", snapshotRef: buildSnapshotSourceRef(snapshot), observedAt: `${label}-time`, proposals };
  };
  const anchor = (current: ProposalSetObservation, checkedAt: string) => ({ checkedAt, resultKind: "changed" as const, currentSnapshotRef: current.snapshotRef });

  test("commits unscored proposals and emits the confidence loss as a fact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-confidence-"));
    try {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
      const first = observation("confidence-1", 1, [withConfidence("same", 0.8)]);
      assert.equal((await emitter.emit({ source: source(), current: first, check: anchor(first, "one"), callbacks })).ok, true);
      const second = observation("confidence-2", 2, [withoutConfidence("same")]);
      const result = await emitter.emit({ source: source(), current: second, check: anchor(second, "two"), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return assert.fail("expected success");
      assert.equal(Object.hasOwn(result.value.committedObservation!.proposals[0]!, "confidence"), false);
      const fact = result.value.facts[0];
      assert.equal(fact?.kind, "proposal-set-facts"); if (fact?.kind !== "proposal-set-facts") return;
      assert.equal(fact.value.confidenceChanges?.length, 1);
      assert.equal(fact.value.confidenceChanges?.[0]?.prior.confidence, 0.8);
      assert.equal(Object.hasOwn(fact.value.confidenceChanges![0]!.current, "confidence"), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("semantic review work", () => {
  test("a candidate from an unscored proposal carries no confidence at either level", () => {
    const result = buildSemanticReviewWork({
      prior: plain("snapshot-1", [withConfidence("old", 0.8)]),
      current: plain("snapshot-2", [withoutConfidence("new")]),
      observationIdentity: { prior: "observation-prior", current: "observation-current" },
      ...callbacks,
      claimTarget: (change: SemanticReviewChange) => ({ subjectType: "record", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
    });
    assert.equal(result.ok, true); if (!result.ok) return;
    const [item] = result.value.items;
    const [priorCandidate, proposedCandidate] = item?.spec.candidates ?? [];
    assert.equal(priorCandidate?.confidence, 0.8);
    assert.equal(priorCandidate?.extraction.confidence, 0.8);
    assert.ok(proposedCandidate);
    assert.equal(Object.hasOwn(proposedCandidate, "confidence"), false);
    assert.equal(Object.hasOwn(proposedCandidate.extraction, "confidence"), false);
    assert.equal(proposedCandidate.extraction.extractor, "example-extractor:v1");
  });
});
