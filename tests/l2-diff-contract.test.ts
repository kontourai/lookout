import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractionProposal } from "@kontourai/traverse";
import * as publicApi from "../src/index.js";

type Result<T> = { ok: true; value: T } | { ok: false; error: { kind: string } };
type IdentityResult = { ok: true; key: string } | { ok: false; error: { kind: string } };
type Observation = {
  sourceId: string;
  snapshotRef: string;
  observedAt: string;
  proposals: readonly ExtractionProposal[];
};
type KernelApi = {
  canonicalValueKey(value: unknown): { ok: true; key: string } | { ok: false; error: { kind: string } };
  compareStructural(
    prior: unknown,
    current: unknown,
    options?: { value?: (item: any) => unknown; provenance?: (item: any) => unknown },
  ): Result<{ valueChanged: boolean; provenanceChanged: boolean }>;
  diffKeyedMultiset<T>(
    prior: readonly T[],
    current: readonly T[],
    options: { identity: (item: T) => string | IdentityResult },
  ): Result<{
    unchanged: boolean;
    retained: readonly { prior: T; current: T }[];
    additions: readonly T[];
    removals: readonly T[];
  }>;
  diffProposalSets<E>(input: {
    prior: Observation;
    current: Observation;
    selectEntities: (observation: Observation) => readonly E[];
    entityIdentity: (entity: E) => string | IdentityResult;
    proposalsFor: (entity: E) => readonly ExtractionProposal[];
    fieldIdentity: (entity: E, proposal: ExtractionProposal) => string | IdentityResult;
  }): Result<{
    events: readonly any[];
    facts: { provenanceChanges: readonly any[]; removedEntities: readonly any[] };
  }>;
};

const api = publicApi as unknown as Partial<KernelApi>;

function required<K extends keyof KernelApi>(name: K): KernelApi[K] {
  const value = api[name];
  assert.equal(typeof value, "function", `package root must export ${name}`);
  return value as KernelApi[K];
}

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    fieldPath: "records[].label",
    pathIndices: [0],
    candidateValue: "Alpha",
    confidence: 0.9,
    provenance: { excerpt: "Alpha", locator: "chars:0-5" },
    extractor: "fixture-extractor:v1",
    ...overrides,
  };
}

function observation(
  snapshotRef: string,
  proposals: readonly ExtractionProposal[],
  sourceId = "source-example",
): Observation {
  return { sourceId, snapshotRef, observedAt: "2026-07-10T00:00:00.000Z", proposals };
}

describe("S-AC1 canonical type-tagged identity", () => {
  test("pins lookout canonical v1 bytes across the full tagged edge matrix", () => {
    const canonicalValueKey = required("canonicalValueKey");
    const hole = Array(1);
    const matrix: readonly [string, unknown, string][] = [
      ["undefined", undefined, "u0:"],
      ["null", null, "n0:"],
      ["true", true, "b1:1"],
      ["false", false, "b1:0"],
      ["hole", hole, "a3:h0:"],
      ["undefined element", [undefined], "a6:e3:u0:"],
      ["negative zero", -0, "d2:-0"],
      ["NaN", Number.NaN, "d3:nan"],
      ["positive infinity", Number.POSITIVE_INFINITY, "d4:+inf"],
      ["negative infinity", Number.NEGATIVE_INFINITY, "d4:-inf"],
      ["bigint", 123n, "i3:123"],
      ["key order", { b: 2, a: 1 }, "o22:k1:av4:d1:1k1:bv4:d1:2"],
      ["delimiter string", "a:b|c", "s5:a:b|c"],
    ];
    for (const [name, value, expected] of matrix) {
      const result = canonicalValueKey(value);
      assert.equal(result.ok, true, name);
      if (result.ok) assert.equal(result.key, expected, name);
    }
    const reordered = canonicalValueKey({ a: 1, b: 2 });
    assert.equal(reordered.ok, true);
    if (reordered.ok) assert.equal(reordered.key, matrix[11]![2]);
  });

  test("distinguishes collision cases and recursively normalizes object key order", () => {
    const canonicalValueKey = required("canonicalValueKey");
    const key = (value: unknown) => {
      const result = canonicalValueKey(value);
      assert.equal(result.ok, true);
      return result.ok ? result.key : "";
    };
    const hole = Array(1);
    const distinctPairs: readonly [unknown, unknown][] = [
      [{ a: undefined }, {}],
      [[undefined], [null]],
      [hole, [undefined]],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      [Number.NEGATIVE_INFINITY, null],
      [-0, 0],
      ["a:b|c", "a|b:c"],
    ];
    for (const [left, right] of distinctPairs) assert.notEqual(key(left), key(right));
    assert.equal(key({ b: 2, a: { d: 4, c: 3 } }), key({ a: { c: 3, d: 4 }, b: 2 }));
    assert.notEqual(key(1n), key("1"));
  });

  test("returns typed errors for cycles, symbols, functions, and exotic objects", () => {
    const canonicalValueKey = required("canonicalValueKey");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, Symbol("x"), () => undefined, new Date(0)]) {
      const result = canonicalValueKey(value);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(typeof result.error.kind, "string");
    }
  });
});

describe("S-AC2 stable keyed multiset facts", () => {
  test("preserves duplicate counts, stable pairing, additions, and removals", () => {
    const diff = required("diffKeyedMultiset");
    const result = diff(["a1", "a2", "b1"], ["a3", "b2", "a4", "c1"], {
      identity: (item) => item[0]!,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.retained, [
      { prior: "a1", current: "a3" },
      { prior: "a2", current: "a4" },
      { prior: "b1", current: "b2" },
    ]);
    assert.deepEqual(result.value.additions, ["c1"]);
    assert.deepEqual(result.value.removals, []);
  });

  test("treats reorder-only input as unchanged and contains callback throws", () => {
    const diff = required("diffKeyedMultiset");
    const reordered = diff(["a", "b", "a"], ["a", "a", "b"], { identity: (item) => item });
    assert.equal(reordered.ok, true);
    if (reordered.ok) assert.equal(reordered.value.unchanged, true);
    const thrown = diff(["a"], ["a"], { identity: () => { throw new Error("fixture failure"); } });
    assert.equal(thrown.ok, false);
    if (!thrown.ok) assert.equal(typeof thrown.error.kind, "string");
  });
});

test("S-AC3 separates semantic value change from provenance-only change", () => {
  const compare = required("compareStructural");
  const result = compare(
    { value: "same", provenance: { locator: "chars:0-4" } },
    { value: "same", provenance: { locator: "chars:20-24" } },
    { value: (item) => item.value, provenance: (item) => item.provenance },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { valueChanged: false, provenanceChanged: true });
});

describe("S-AC4 through S-AC7 proposal event composition", () => {
  const entitySelector = (input: Observation) => {
    const byIndex = new Map<number, ExtractionProposal[]>();
    for (const item of input.proposals) {
      const index = item.pathIndices?.[0] ?? -1;
      byIndex.set(index, [...(byIndex.get(index) ?? []), item]);
    }
    return [...byIndex.entries()].map(([index, proposals]) => ({ index, proposals }));
  };
  const options = {
    selectEntities: entitySelector,
    entityIdentity: (entity: ReturnType<typeof entitySelector>[number]) => `entity-${entity.index}`,
    proposalsFor: (entity: ReturnType<typeof entitySelector>[number]) => entity.proposals,
    fieldIdentity: (_entity: unknown, item: ExtractionProposal) => item.fieldPath,
  };

  test("emits only deterministic appearance and field-change vocabulary in stable order", () => {
    const diff = required("diffProposalSets");
    const prior = observation("snapshot-prior", [proposal()]);
    const current = observation("snapshot-current", [
      proposal({ candidateValue: "Beta" }),
      proposal({ fieldPath: "records[].detail", candidateValue: "Detail" }),
      proposal({ pathIndices: [1], candidateValue: "Second" }),
    ]);
    const first = diff({ prior, current, ...options });
    const second = diff({ prior, current, ...options });
    assert.equal(first.ok, true);
    assert.deepEqual(second, first);
    if (!first.ok) return;
    assert.deepEqual(first.value.events.map((event) => event.kind), ["field-changed", "field-changed", "new-entity-appeared"]);
    assert.equal(first.value.events.some((event) => event.kind === "entity-disappeared"), false);
    assert.equal(first.value.events.some((event) => event.kind === "anticipated-value-arrived"), false);
  });

  test("carries complete observation and proposal evidence and rejects source mismatch", () => {
    const diff = required("diffProposalSets");
    const prior = observation("snapshot-prior", [proposal()]);
    const current = observation("snapshot-current", [proposal({ candidateValue: "Beta" })]);
    const result = diff({ prior, current, ...options });
    assert.equal(result.ok, true);
    if (result.ok) {
      const event = result.value.events[0];
      assert.equal(event.entityKey, "entity-0");
      assert.equal(event.fieldKey, "records[].label");
      for (const side of [event.prior, event.current]) {
        assert.equal(side.sourceId, "source-example");
        assert.equal(typeof side.snapshotRef, "string");
        assert.equal(typeof side.observedAt, "string");
        assert.equal(typeof side.confidence, "number");
        assert.equal(typeof side.provenance.excerpt, "string");
        assert.equal(typeof side.provenance.locator, "string");
        assert.equal(typeof side.extractor, "string");
      }
    }
    const mismatch = diff({ prior, current: observation("snapshot-current", [], "source-other"), ...options });
    assert.equal(mismatch.ok, false);
  });

  test("records provenance movement and removals as facts without events", () => {
    const diff = required("diffProposalSets");
    const moved = diff({
      prior: observation("snapshot-prior", [proposal()]),
      current: observation("snapshot-current", [proposal({ provenance: { excerpt: "Alpha", locator: "chars:20-25" } })]),
      ...options,
    });
    assert.equal(moved.ok, true);
    if (moved.ok) {
      assert.deepEqual(moved.value.events, []);
      assert.equal(moved.value.facts.provenanceChanges.length, 1);
    }
    const removed = diff({
      prior: observation("snapshot-prior", [proposal(), proposal({ pathIndices: [1] })]),
      current: observation("snapshot-current", [proposal()]),
      ...options,
    });
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.deepEqual(removed.value.events, []);
      assert.equal(removed.value.facts.removedEntities.length, 1);
    }
  });

  test("contains selector failures and has no policy, provider, render, fetch, or persistence inputs", () => {
    const diff = required("diffProposalSets");
    const prior = observation("snapshot-prior", []);
    const current = observation("snapshot-current", []);
    let boundaryCalls = 0;
    const forbiddenPolicyAndIo = {
      confidenceFloor: 0.5,
      suppressionWindow: "fixture-window",
      reviewMode: "fixture-mode",
      providerResolver: () => { boundaryCalls += 1; },
      render: () => { boundaryCalls += 1; },
      fetch: () => { boundaryCalls += 1; },
      persist: () => { boundaryCalls += 1; },
    };
    const boundaryResult = diff({ prior, current, ...options, ...forbiddenPolicyAndIo });
    assert.equal(boundaryResult.ok, true);
    assert.equal(boundaryCalls, 0);
    const result = diff({
      prior,
      current,
      ...options,
      ...forbiddenPolicyAndIo,
      selectEntities: () => { throw new Error("fixture failure"); },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(options).sort(), ["entityIdentity", "fieldIdentity", "proposalsFor", "selectEntities"]);
  });
});
