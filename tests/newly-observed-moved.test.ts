import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractionCoverageEntry, ExtractionProposal } from "@kontourai/traverse";
import { buildSemanticReviewWork, diffProposalSets, type ProposalSetIncompleteness, type ProposalSetObservation, type SemanticReviewChange } from "../src/index.js";

// An incomplete prior that did read a field must not have that field reported
// as newly observed when the current run finds it at another offset (a
// preface line pushed it down). The move is the one reviewable change.

const at = (fieldPath: string, value: string, start: number): ExtractionProposal => ({
  fieldPath, pathIndices: [0], candidateValue: value, confidence: 0.9,
  provenance: { locator: `chars:${start}-${start + value.length + 8}`, excerpt: `Status: ${value}` }, extractor: "example-extractor:v1",
});
const coverage: ExtractionCoverageEntry[] = [
  { chunk: 1, start: 0, end: 40, status: "complete" },
  { chunk: 2, start: 40, end: 80, status: "unread", reason: "provider-failure" },
];
const lostChunk: ProposalSetIncompleteness = { reason: "provider-failure", coverage };
const observation = (snapshotRef: string, proposals: readonly ExtractionProposal[], incomplete?: ProposalSetIncompleteness): ProposalSetObservation =>
  ({ sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-time`, proposals, ...(incomplete ? { incomplete } : {}) });
type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const callbacks = {
  selectEntities: (input: ProposalSetObservation): readonly Entity[] => [{ key: "record-0", proposals: input.proposals }],
  entityIdentity: (entity: Entity) => entity.key,
  proposalsFor: (entity: Entity) => entity.proposals,
  fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
};
const project = (prior: ProposalSetObservation, current: ProposalSetObservation) => buildSemanticReviewWork({
  prior, current, ...callbacks,
  observationIdentity: { prior: "observation-prior", current: "observation-current" },
  claimTarget: (change: SemanticReviewChange) => ({ subjectType: "record", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
});
const items = (result: ReturnType<typeof project>) => result.ok
  ? result.value.items.map((item) => ({ kind: item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind, target: item.spec.target }))
  : assert.fail("projection failed");

// Prior (incomplete) read `Status: Active` at offset 0; the current text has a
// preface line, so the same value now sits at offset 12.
const prior = observation("snapshot-1", [at("status", "Active", 0)], lostChunk);
const moved = observation("snapshot-2", [at("status", "Active", 12)]);

describe("an incomplete prior that read a field that later moved", () => {
  test("yields exactly one review item, the move", () => {
    assert.deepEqual(items(project(prior, moved)), [{ kind: "proposal-moved", target: "status" }]);
  });

  test("keeps the moved occurrence out of the newly observed facts", () => {
    const result = diffProposalSets({ prior, current: moved, ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.facts.newlyObservedProposalEvidence, []);
    assert.deepEqual(result.value.facts.newlyObservedProposalOccurrences, []);
    assert.equal(result.value.facts.provenanceChanges.length, 1);
    // The occurrence is still accounted for: the prior read it, so it is added at its new offset.
    assert.deepEqual(result.value.facts.addedProposalOccurrences, [moved.proposals[0]]);
  });

  test("a value the prior never read is still one newly observed item", () => {
    const current = observation("snapshot-2", [at("status", "Active", 0), at("owner", "Example", 50)]);
    assert.deepEqual(items(project(prior, current)), [{ kind: "proposal-newly-observed", target: "owner" }]);
    const result = diffProposalSets({ prior, current, ...callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.value.facts.newlyObservedProposalEvidence?.length, 1);
    assert.equal(result.value.facts.newlyObservedProposalEvidence?.[0]?.fieldPath, "owner");
  });

  test("a field the prior read, moved and re-valued, yields the same work as against a complete prior", () => {
    const current = observation("snapshot-2", [at("status", "Closed", 12)]);
    const complete = items(project(observation("snapshot-1", prior.proposals), current));
    assert.ok(complete.length > 0);
    assert.ok(complete.every((item) => item.kind !== "proposal-newly-observed"));
    assert.deepEqual(items(project(prior, current)), complete);
  });
});
