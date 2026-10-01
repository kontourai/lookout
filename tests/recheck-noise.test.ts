import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ExtractionProposal } from "@kontourai/traverse";
import { buildSemanticReviewWork, diffProposalSets, type ProposalSetObservation, type SemanticReviewChange } from "../src/index.js";

// A recorded pair of observations of one public specification page, extracted
// by a real model before and after one editor was removed from the page. The
// only source change is the editor count going from 4 to 3.
const recorded = (name: string): ProposalSetObservation =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/recheck-noise/${name}.json`, import.meta.url), "utf8")) as ProposalSetObservation;
const recordedPrior = recorded("prior-observation");
const recordedCurrent = recorded("current-observation");

const callbacks = {
  selectEntities: (observation: ProposalSetObservation) => [observation],
  entityIdentity: (observation: ProposalSetObservation) => observation.sourceId,
  proposalsFor: (observation: ProposalSetObservation) => observation.proposals,
  fieldIdentity: (_observation: ProposalSetObservation, proposal: ExtractionProposal) => proposal.fieldPath,
};

function review(prior: ProposalSetObservation, current: ProposalSetObservation) {
  const result = buildSemanticReviewWork({
    prior,
    current,
    observationIdentity: { prior: "observation-prior", current: "observation-current" },
    ...callbacks,
    claimTarget: (change: SemanticReviewChange) => ({ subjectType: "document", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("review projection failed");
  return result.value.items.map((item) => ({
    kind: item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind,
    target: item.spec.target,
    values: item.spec.candidates.map((candidate) => candidate.value),
    locators: item.spec.candidates.map((candidate) => candidate.locator?.locator),
  }));
}

function facts(prior: ProposalSetObservation, current: ProposalSetObservation) {
  const result = diffProposalSets({ prior, current, ...callbacks });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("diff failed");
  return result.value.facts;
}

type Occurrence = NonNullable<ExtractionProposal["provenance"]["occurrence"]>;
const occurrence = (start: number, end: number, overrides: Partial<Occurrence> = {}): Occurrence => ({
  resolverVersion: "exact-occurrence-v1",
  count: 1,
  selected: { index: 0, start, end },
  selection: "source-order",
  hintUsed: false,
  ambiguous: false,
  ...overrides,
});

/** One proposal whose excerpt sits at `start`, with resolver metadata shaped as the resolver writes it. */
function cited(candidateValue: unknown, excerpt: string, start: number, overrides: Partial<Occurrence> = {}): ExtractionProposal {
  const end = start + excerpt.length;
  return {
    fieldPath: "doc.field",
    candidateValue,
    confidence: 1,
    provenance: { excerpt, locator: `chars:${start}-${end}`, occurrence: occurrence(start, end, overrides) },
    extractor: "example-extractor:v1",
  };
}

const pair = (prior: ExtractionProposal, current: ExtractionProposal): [ProposalSetObservation, ProposalSetObservation] => [
  { sourceId: "source-example", snapshotRef: "snapshot-prior", observedAt: "2026-01-01T00:00:00.000Z", proposals: [prior] },
  { sourceId: "source-example", snapshotRef: "snapshot-current", observedAt: "2026-01-02T00:00:00.000Z", proposals: [current] },
];

describe("recheck review noise", () => {
  test("the recorded recheck yields one item per field that changed, and nothing else", () => {
    // Guards against a fixture that no longer holds the differences under test.
    const selections = (observation: ProposalSetObservation) => [...new Set(observation.proposals.map((proposal) => proposal.provenance.occurrence?.selection))];
    assert.deepEqual(selections(recordedPrior), ["occurrence-hint"]);
    assert.deepEqual(selections(recordedCurrent), ["source-order"]);
    assert.equal(recordedPrior.proposals.length, 6);
    assert.equal(recordedCurrent.proposals.length, 6);

    assert.deepEqual(review(recordedPrior, recordedCurrent), [
      { kind: "proposal-value-changed", target: "doc.publicationDate", values: ["21 March 2013", "2013-03-21"], locators: ["chars:89-124", "chars:89-124"] },
      { kind: "proposal-value-changed", target: "doc.editorCount", values: [4, 3], locators: ["chars:502-918", "chars:502-826"] },
    ]);
  });

  test("the recorded pair keeps every non-item difference as a fact", () => {
    const recordedFacts = facts(recordedPrior, recordedCurrent);
    // The editor list really is cited from a different span.
    assert.deepEqual(recordedFacts.provenanceChanges.map((change) => [change.fieldKey, change.prior.provenance.locator, change.current.provenance.locator]), [["doc.editorCount", "chars:502-918", "chars:502-826"]]);
    assert.deepEqual(recordedFacts.excerptBoundaryChanges?.map((change) => [change.fieldKey, change.prior.provenance.locator, change.current.provenance.locator]), [["doc.firstEditor", "chars:502-599", "chars:512-599"]]);
  });

  test("a different selection of the same resolved occurrence is not a provenance change", () => {
    const prior = cited("Recommendation", "Status: Recommendation", 40, { selection: "occurrence-hint", hintUsed: true });
    const current = cited("Recommendation", "Status: Recommendation", 40);
    assert.deepEqual(review(...pair(prior, current)), []);
    assert.deepEqual(facts(...pair(prior, current)).provenanceChanges, []);
    // Equal outright, not merely tolerated as a re-cut excerpt.
    assert.equal(facts(...pair(prior, current)).excerptBoundaryChanges, undefined);
    // Holds for a derived value the excerpt does not literally contain.
    const counted = (overrides: Partial<Occurrence>) => cited(4, "Editors: Ada, Bo, Cy, Di", 40, overrides);
    assert.deepEqual(review(...pair(counted({ selection: "occurrence-hint", hintUsed: true }), counted({}))), []);
  });

  test("a different occurrence of the same value is still reported, as one move", () => {
    // Same value, same excerpt text, but the second of two matches: a real move.
    const prior = cited("Recommendation", "Status: Recommendation", 40, { count: 2, ambiguous: true, selection: "occurrence-hint", hintUsed: true });
    const current = cited("Recommendation", "Status: Recommendation", 300, { count: 2, ambiguous: true, selected: { index: 1, start: 300, end: 322 } });
    assert.deepEqual(review(...pair(prior, current)), [
      { kind: "proposal-moved", target: "doc.field", values: ["Recommendation", "Recommendation"], locators: ["chars:40-62", "chars:300-322"] },
    ]);
  });

  test("resolver facts other than the selection still count as provenance", () => {
    const prior = cited("Recommendation", "Status: Recommendation", 40, { selection: "occurrence-hint", hintUsed: true });
    // The excerpt now matches twice, so the same span is no longer the only candidate.
    const current = cited("Recommendation", "Status: Recommendation", 40, { count: 2, ambiguous: true });
    assert.deepEqual(review(...pair(prior, current)).map((item) => item.kind), ["proposal-provenance-changed"]);
  });

  test("an excerpt cut differently around a value that stayed put creates no work", () => {
    const text = "Editors:\n\nAda Example, Example Institute";
    const prior = cited("Ada Example", text, 502, { selection: "occurrence-hint", hintUsed: true });
    const narrowed = cited("Ada Example", text.slice(10), 512);
    const widened = cited("Ada Example", `Section 1\n\n${text}`, 491);
    for (const current of [narrowed, widened]) {
      assert.deepEqual(review(...pair(prior, current)), []);
      const boundaryFacts = facts(...pair(prior, current));
      assert.deepEqual(boundaryFacts.provenanceChanges, []);
      assert.equal(boundaryFacts.excerptBoundaryChanges?.length, 1);
      // The exact occurrence facts are untouched: the locator did change.
      assert.equal(boundaryFacts.removedProposalOccurrences.length, 1);
      assert.equal(boundaryFacts.addedProposalOccurrences.length, 1);
    }
  });

  test("a re-cut excerpt is still one move when the value itself is somewhere else", () => {
    const text = "Editors:\n\nAda Example, Example Institute";
    const prior = cited("Ada Example", text, 502);
    const cases: Array<[string, ExtractionProposal]> = [
      // The same excerpt at other offsets.
      ["shifted", cited("Ada Example", text, 530)],
      // A narrower excerpt whose value lands at another offset.
      ["narrowed and shifted", cited("Ada Example", text.slice(10), 540)],
      // Overlapping spans whose shared text is not the same text.
      ["different text", cited("Ada Example", "Authors:\n\nAda Example, Another Institute", 502)],
      // Excerpts that do not overlap at all.
      ["disjoint", cited("Ada Example", "Ada Example", 900)],
      // The first match in one excerpt is a different place than in the other.
      ["earlier match", cited("Ada Example", `Ada Example and ${text}`, 486)],
    ];
    for (const [label, current] of cases) {
      const items = review(...pair(prior, current));
      assert.deepEqual(items.map((item) => item.kind), [prior.provenance.locator === current.provenance.locator ? "proposal-provenance-changed" : "proposal-moved"], label);
      assert.equal(facts(...pair(prior, current)).excerptBoundaryChanges, undefined, label);
    }
  });

  test("a re-cut excerpt is a move when the value cannot be located in it", () => {
    // A derived value (a count) has no span of its own inside the excerpt.
    const list = "Ada Example\n\nBo Example\n\nCy Example";
    assert.deepEqual(review(...pair(cited(3, `Editors:\n\n${list}`, 502), cited(3, list, 512))).map((item) => item.kind), ["proposal-moved"]);
    // Digits are not located: "3" also occurs inside other numbers.
    assert.deepEqual(review(...pair(cited(3, "Editors (3):\n\nAda Example", 502), cited(3, "(3):\n\nAda Example", 510))).map((item) => item.kind), ["proposal-moved"]);
    // A locator that does not describe its excerpt cannot vouch for an offset.
    const malformed = cited("Ada Example", "Ada Example, Example Institute", 512);
    const broken: ExtractionProposal = { ...malformed, provenance: { ...malformed.provenance, locator: "chars:512-530" } };
    assert.deepEqual(review(...pair(cited("Ada Example", "Editors:\n\nAda Example, Example Institute", 502), broken)).map((item) => item.kind), ["proposal-moved"]);
    // A resolution that became ambiguous is not the same citation.
    const ambiguous = cited("Ada Example", "Ada Example, Example Institute", 512, { count: 2, ambiguous: true });
    assert.deepEqual(review(...pair(cited("Ada Example", "Editors:\n\nAda Example, Example Institute", 502), ambiguous)).map((item) => item.kind), ["proposal-moved"]);
  });

  test("a value change that also moved is one item carrying both locators", () => {
    const prior = cited("4 editors", "Count: 4 editors", 100);
    const current = cited("3 editors", "Count: 3 editors", 140);
    assert.deepEqual(review(...pair(prior, current)), [
      { kind: "proposal-value-changed", target: "doc.field", values: ["4 editors", "3 editors"], locators: ["chars:100-116", "chars:140-156"] },
    ]);
    // The move itself is still a recorded fact.
    assert.equal(facts(...pair(prior, current)).provenanceChanges.length, 1);
  });

  test("a value change that lost its provenance still raises the gap", () => {
    const prior = cited("4 editors", "Count: 4 editors", 100);
    const current: ExtractionProposal = { ...cited("3 editors", "Count: 3 editors", 100), provenance: { excerpt: "", locator: "" } };
    assert.deepEqual(review(...pair(prior, current)).map((item) => item.kind), ["proposal-value-changed", "provenance-gap"]);
  });

  test("an incomplete recheck of the recorded pair reports no removal", () => {
    const partial: ProposalSetObservation = { ...recordedCurrent, proposals: recordedCurrent.proposals.filter((proposal) => proposal.fieldPath !== "doc.status"), incomplete: { reason: "max-total-tokens" } };
    const items = review(recordedPrior, partial);
    assert.deepEqual(items.map((item) => [item.kind, item.target]), [["proposal-value-changed", "doc.publicationDate"], ["proposal-value-changed", "doc.editorCount"]]);
    // The same missing field in a complete run is a removal.
    const { incomplete: _incomplete, ...complete } = partial;
    assert.deepEqual(review(recordedPrior, complete).map((item) => [item.kind, item.target]).filter(([kind]) => kind === "proposal-removed"), [["proposal-removed", "doc.status"]]);
  });
});
