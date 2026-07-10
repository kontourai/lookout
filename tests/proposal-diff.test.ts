import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractionProposal } from "@kontourai/traverse";
import {
  diffProposalSets,
  extractionProposalIdentity,
  type ProposalSetObservation,
} from "../src/index.js";

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    fieldPath: "entries[].value",
    pathIndices: [0],
    candidateValue: "old",
    confidence: 0.8,
    provenance: { excerpt: "old", locator: "chars:0-3" },
    extractor: "example-extractor:v1",
    ...overrides,
  };
}

function observation(snapshotRef: string, proposals: readonly ExtractionProposal[], sourceId = "source-a"): ProposalSetObservation {
  return { sourceId, snapshotRef, observedAt: `${snapshotRef}-time`, proposals };
}

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
function entities(input: ProposalSetObservation): readonly Entity[] {
  const grouped = new Map<number, ExtractionProposal[]>();
  for (const item of input.proposals) {
    const index = item.pathIndices?.[0] ?? -1;
    grouped.set(index, [...(grouped.get(index) ?? []), item]);
  }
  return [...grouped].map(([index, proposals]) => ({ key: `entry-${index}`, proposals }));
}
const callbacks = {
  selectEntities: entities,
  entityIdentity: (entity: Entity) => entity.key,
  proposalsFor: (entity: Entity) => entity.proposals,
  fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
};

describe("exact proposal occurrence identity", () => {
  test("uses normalized field path, presence-sensitive indices, and verified locator only", () => {
    const base = proposal();
    const same = proposal({ candidateValue: "different", confidence: 0.1, extractor: "other", provenance: { excerpt: "other", locator: "chars:0-3" } });
    const absent = proposal();
    delete absent.pathIndices;
    const empty = proposal({ pathIndices: [] });
    const keys = [base, same, absent, empty, proposal({ fieldPath: "entries[].other" }), proposal({ provenance: { excerpt: "old", locator: "chars:4-7" } })]
      .map(extractionProposalIdentity);
    assert.ok(keys.every((result) => result.ok));
    if (!keys.every((result) => result.ok)) return;
    assert.equal(keys[0].key, keys[1].key);
    assert.notEqual(keys[2].key, keys[3].key);
    assert.notEqual(keys[0].key, keys[4].key);
    assert.notEqual(keys[0].key, keys[5].key);
  });

  test("contains hostile proposal inspection", () => {
    const hostile = new Proxy({} as ExtractionProposal, {
      get() { throw new Error("hostile proposal"); },
      getOwnPropertyDescriptor() { throw new Error("hostile proposal"); },
    });
    const result = extractionProposalIdentity(hostile);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "unsupported-value");
  });
});

describe("proposal set facts and events", () => {
  test("classifies deterministic two-sided value changes without policy", () => {
    const cases: readonly [unknown, unknown, string][] = [
      [undefined, "ready", "value-populated"],
      ["old", "new", "value-updated"],
      ["old", 1, "value-replaced"],
      [["a"], ["a", "b"], "items-added"],
      [["a", "b"], ["a"], "items-removed"],
      [["a"], ["b"], "value-replaced"],
    ];
    for (const [priorValue, currentValue, expected] of cases) {
      const result = diffProposalSets({
        prior: observation("prior", [proposal({ candidateValue: priorValue })]),
        current: observation("current", [proposal({ candidateValue: currentValue })]),
        ...callbacks,
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.events.length, 1);
        assert.equal(result.value.events[0]?.kind, "field-changed");
        if (result.value.events[0]?.kind === "field-changed") assert.equal(result.value.events[0].changeKind, expected);
      }
    }
  });

  test("keeps exact occurrence facts while correlating a moved span semantically", () => {
    const priorProposal = proposal();
    const currentProposal = proposal({ provenance: { excerpt: "old", locator: "chars:20-23" } });
    const result = diffProposalSets({
      prior: observation("prior", [priorProposal]),
      current: observation("current", [currentProposal]),
      ...callbacks,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.events, []);
    assert.equal(result.value.facts.provenanceChanges.length, 1);
    assert.deepEqual(result.value.facts.retainedProposalOccurrences, []);
    assert.deepEqual(result.value.facts.removedProposalOccurrences, [priorProposal]);
    assert.deepEqual(result.value.facts.addedProposalOccurrences, [currentProposal]);
  });

  test("treats incomplete current observations and removed entities as facts only", () => {
    const prior = [proposal(), proposal({ pathIndices: [1], candidateValue: "second" })];
    const result = diffProposalSets({ prior: observation("prior", prior), current: observation("current", []), ...callbacks });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.events, []);
    assert.deepEqual(result.value.facts.removedEntities, ["entry-0", "entry-1"]);
    assert.deepEqual(result.value.facts.removedProposalOccurrences, prior);
  });

  test("emits one-sided field removals only inside retained entities and retains occurrence facts", () => {
    const retained = proposal({ fieldPath: "entries[].retained", candidateValue: "same" });
    const removedItems = proposal({ fieldPath: "entries[].items", candidateValue: ["a", "b"] });
    const removedScalar = proposal({ fieldPath: "entries[].note", candidateValue: "gone" });
    const result = diffProposalSets({
      prior: observation("prior", [retained, removedItems, removedScalar]),
      current: observation("current", [retained]),
      ...callbacks,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.events.map((event) => event.kind === "field-changed"
      ? [event.fieldKey, event.changeKind, event.prior?.value, event.current]
      : [event.kind]), [
      ["entries[].items", "items-removed", ["a", "b"], undefined],
      ["entries[].note", "value-replaced", "gone", undefined],
    ]);
    assert.deepEqual(result.value.facts.removedProposalOccurrences, [removedItems, removedScalar]);
  });

  test("preserves stable input ordering and complete evidence", () => {
    const current = [proposal({ pathIndices: [2], candidateValue: "two" }), proposal({ pathIndices: [1], candidateValue: "one" })];
    const result = diffProposalSets({ prior: observation("prior", []), current: observation("current", current), ...callbacks });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.events.map((event) => event.kind), ["new-entity-appeared", "new-entity-appeared"]);
    assert.deepEqual(result.value.events.map((event) => event.entityKey), ["entry-2", "entry-1"]);
    const side = result.value.events[0]?.kind === "new-entity-appeared" ? result.value.events[0].current[0] : undefined;
    assert.deepEqual(side && {
      sourceId: side.sourceId, snapshotRef: side.snapshotRef, observedAt: side.observedAt,
      entityKey: side.entityKey, fieldKey: side.fieldKey, value: side.value,
      confidence: side.confidence, provenance: side.provenance, extractor: side.extractor,
    }, {
      sourceId: "source-a", snapshotRef: "current", observedAt: "current-time",
      entityKey: "entry-2", fieldKey: "entries[].value", value: "two",
      confidence: 0.8, provenance: { excerpt: "old", locator: "chars:0-3" }, extractor: "example-extractor:v1",
    });
  });

  test("reordered fields do not create semantic output", () => {
    const left = proposal({ fieldPath: "entries[].left", candidateValue: "left" });
    const right = proposal({ fieldPath: "entries[].right", candidateValue: "right" });
    const result = diffProposalSets({
      prior: observation("prior", [left, right]),
      current: observation("current", [right, left]),
      ...callbacks,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.events, []);
  });

  test("returns typed errors for source mismatch and every caller callback", () => {
    const base = { prior: observation("prior", [proposal()]), current: observation("current", [proposal()]), ...callbacks };
    const mismatch = diffProposalSets({ ...base, current: observation("current", [], "source-b") });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.kind, "unsupported-value");
    for (const override of [
      { selectEntities: () => { throw new Error("selector"); } },
      { entityIdentity: () => { throw new Error("entity identity"); } },
      { proposalsFor: () => { throw new Error("proposals"); } },
      { fieldIdentity: () => { throw new Error("field identity"); } },
    ]) {
      const result = diffProposalSets({ ...base, ...override });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "callback-threw");
    }
    const rejectedIdentity = { ok: false as const, error: { kind: "unsupported-value" as const, message: "rejected identity" } };
    for (const override of [
      { entityIdentity: () => rejectedIdentity },
      { fieldIdentity: () => rejectedIdentity },
    ]) {
      const result = diffProposalSets({ ...base, ...override });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.message, "rejected identity");
    }
  });

  test("returns typed errors for unsupported candidate values", () => {
    const result = diffProposalSets({
      prior: observation("prior", [proposal({ candidateValue: Symbol("prior") })]),
      current: observation("current", [proposal({ candidateValue: Symbol("current") })]),
      ...callbacks,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "unsupported-value");
  });
});
