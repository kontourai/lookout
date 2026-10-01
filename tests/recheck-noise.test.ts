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
    // Same value, excerpt and locator each time; only what the resolver found differs.
    const prior = cited("Recommendation", "Status: Recommendation", 40, { selection: "occurrence-hint", hintUsed: true });
    const cases: Array<[string, Partial<Occurrence>]> = [
      ["match count", { count: 2 }],
      ["selected index", { selected: { index: 1, start: 40, end: 62 } }],
      ["selected span", { selected: { index: 0, start: 44, end: 66 } }],
      ["ambiguity", { count: 2, ambiguous: true }],
    ];
    for (const [label, overrides] of cases) {
      const current = cited("Recommendation", "Status: Recommendation", 40, overrides);
      assert.deepEqual(review(...pair(prior, current)).map((item) => item.kind), ["proposal-provenance-changed"], label);
      const resolverFacts = facts(...pair(prior, current));
      assert.equal(resolverFacts.provenanceChanges.length, 1, label);
      assert.equal(resolverFacts.excerptBoundaryChanges, undefined, label);
    }
  });

  test("an excerpt narrowed by whole lines around a value that stayed put creates no work", () => {
    const text = "Editors:\n\nAda Example, Example Institute\n\nBo Example, Example Institute";
    const prior = cited("Ada Example", text, 502, { selection: "occurrence-hint", hintUsed: true });
    const cases: Array<[string, ExtractionProposal, string, string]> = [
      ["leading lines", cited("Ada Example", text.slice(10), 512), "Editors:\n\n", ""],
      ["trailing lines", cited("Ada Example", text.slice(0, 40), 502), "", "\n\nBo Example, Example Institute"],
      ["both", cited("Ada Example", text.slice(10, 40), 512), "Editors:\n\n", "\n\nBo Example, Example Institute"],
    ];
    for (const [label, current, droppedBefore, droppedAfter] of cases) {
      assert.deepEqual(review(...pair(prior, current)), [], label);
      const boundaryFacts = facts(...pair(prior, current));
      assert.deepEqual(boundaryFacts.provenanceChanges, [], label);
      // The narrowing is recorded with the text it dropped.
      assert.deepEqual(boundaryFacts.excerptBoundaryChanges?.map((fact) => [fact.prior.provenance.locator, fact.current.provenance.locator, fact.droppedBefore, fact.droppedAfter]), [[prior.provenance.locator, current.provenance.locator, droppedBefore, droppedAfter]], label);
      // The exact occurrence facts are untouched: the locator did change.
      assert.equal(boundaryFacts.removedProposalOccurrences.length, 1, label);
      assert.equal(boundaryFacts.addedProposalOccurrences.length, 1, label);
    }
  });

  /** Exactly one move or provenance-changed item, and no narrowing fact. */
  function reported(label: string, prior: ExtractionProposal, current: ExtractionProposal): void {
    const expected = prior.provenance.locator === current.provenance.locator ? "proposal-provenance-changed" : "proposal-moved";
    assert.deepEqual(review(...pair(prior, current)).map((item) => item.kind), [expected], label);
    assert.equal(facts(...pair(prior, current)).excerptBoundaryChanges, undefined, label);
    assert.equal(facts(...pair(prior, current)).provenanceChanges.length, 1, label);
  }

  test("a re-cut that changes what the citation says is reported", () => {
    // Narrowing that drops text from the value's own line.
    reported("dropped qualifier", cited("Active", "not available: Active", 100), cited("Active", "Active", 115));
    // Widening cites text the prior did not.
    reported("added negation", cited("Active", "Active", 100), cited("Active", "not Active", 96));
    reported("added prefix", cited("active", "active", 100), cited("active", "inactive", 98));
    reported("added digit", cited("1,000 users", "1,000 users", 100), cited("1,000 users", "11,000 users", 99));
    reported("added suffix", cited("Approved", "Approved", 100), cited("Approved", "Approved: no", 100));
    // The reverse of the last: narrowing that drops the rest of the value's line.
    reported("dropped suffix", cited("Approved", "Approved: no", 100), cited("Approved", "Approved", 100));
  });

  test("a re-cut excerpt is still one item unless it is a pure whole-line narrowing", () => {
    const text = "Editors:\n\nAda Example, Example Institute";
    const prior = cited("Ada Example", text, 502);
    // The same excerpt at other offsets.
    reported("shifted", prior, cited("Ada Example", text, 530));
    // A narrower excerpt whose value lands at another offset.
    reported("narrowed and shifted", prior, cited("Ada Example", text.slice(10), 540));
    // The same span, other text.
    reported("different text", prior, cited("Ada Example", "Authors:\n\nAda Example, Example Institute", 502));
    // A narrower span whose text is not the prior's text there.
    reported("narrowed, other text", prior, cited("Ada Example", "Ada Example, Another Institute", 512));
    reported("disjoint", prior, cited("Ada Example", "Ada Example", 900));
    // Whole lines added before: widening, even though the old text is intact.
    reported("widened by lines", prior, cited("Ada Example", `Section 1\n\n${text}`, 491));
    // Overlapping but neither inside the other.
    reported("slid", cited("Ada Example", "Editors:\n\nAda Example", 502), cited("Ada Example", "Ada Example, Example Institute", 512));
    // The narrowing dropped an earlier match, so the first match is elsewhere.
    reported("earlier match dropped", cited("Ada Example", `Ada Example\n${text}`, 490), cited("Ada Example", text.slice(10), 512));
    // Whole lines dropped, but the value is the inside of a longer word.
    reported("inside a word", cited("active", "Status\ninactive today", 100), cited("active", "inactive today", 107));
    reported("inside a number", cited("000", "Total\n1,0001 users", 100), cited("000", "1,0001 users", 106));
  });

  test("a narrowed excerpt is a move when its place cannot be vouched for", () => {
    const wide = "Editors:\n\nAda Example, Example Institute";
    // A derived value (a count) has no span of its own inside the excerpt.
    const list = "Ada Example\n\nBo Example\n\nCy Example";
    reported("derived", cited(3, `Editors:\n\n${list}`, 502), cited(3, list, 512));
    // Digits are not located: "3" also occurs inside other numbers.
    reported("digits", cited(3, "Editors\n(3): Ada Example", 502), cited(3, "(3): Ada Example", 510));
    // A locator that does not describe its excerpt cannot vouch for an offset.
    const narrowed = cited("Ada Example", wide.slice(10), 512);
    reported("malformed locator", cited("Ada Example", wide, 502), { ...narrowed, provenance: { ...narrowed.provenance, locator: "chars:512-530" } });
    // The same when the resolver metadata repeats the wrong span, on the prior side.
    const overlong = cited("Ada Example", wide, 502, { selected: { index: 0, start: 502, end: 560 } });
    reported("malformed prior locator", { ...overlong, provenance: { ...overlong.provenance, locator: "chars:502-560" } }, narrowed);
    // The resolver settled somewhere other than the locator.
    reported("resolved elsewhere", cited("Ada Example", wide, 502), cited("Ada Example", wide.slice(10), 512, { selected: { index: 0, start: 612, end: 642 } }));
    // A resolution that became ambiguous is not the same citation.
    reported("ambiguous", cited("Ada Example", wide, 502), cited("Ada Example", wide.slice(10), 512, { count: 2, ambiguous: true }));
  });

  test("proposals of one field pair by value whatever steered the resolver", () => {
    // Two values cited from one span. Only which of them carried a hint flips.
    const from = (value: string, hinted: boolean) => cited(value, "Ada Example and Bo Example", 40, hinted ? { selection: "occurrence-hint", hintUsed: true } : {});
    const observations = (proposals: ExtractionProposal[], snapshotRef: string): ProposalSetObservation => ({ sourceId: "source-example", snapshotRef, observedAt: "2026-01-01T00:00:00.000Z", proposals });
    const prior = observations([from("Ada Example", true), from("Bo Example", false)], "snapshot-prior");
    const current = observations([from("Ada Example", false), from("Bo Example", true)], "snapshot-current");
    assert.deepEqual(review(prior, current), []);
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
