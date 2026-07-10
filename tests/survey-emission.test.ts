import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtractionProposal } from "@kontourai/traverse";
import { buildSurveyTrustBundle } from "@kontourai/survey";
import { createObservationStore, createSurveyEmitter, type ProposalSetObservation } from "../src/index.js";
import { source } from "./helpers.js";

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const proposal = (value: unknown, overrides: Partial<ExtractionProposal> = {}): ExtractionProposal => ({
  fieldPath: "entries[].value", pathIndices: [0], candidateValue: value, confidence: 0.9,
  provenance: { locator: "chars:0-5", excerpt: String(value) }, extractor: "example-extractor:v1", ...overrides,
});
const observation = (ref: string, proposals: readonly ExtractionProposal[]): ProposalSetObservation => ({ sourceId: "source-a", snapshotRef: ref, observedAt: `${ref}-time`, proposals });
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

test("L3-AC4 first observation is a fact-only baseline and does not call diff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
  try {
    let calls = 0;
    const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), diff: () => { calls++; throw new Error("must not run"); }, now: () => "2026-07-10T12:00:00.000Z" });
    const result = await emitter.emit({ source: source(), current: observation("snapshot-1", [proposal("old")]), check: { checkedAt: "checked", resultKind: "changed", currentSnapshotRef: "snapshot-1" }, callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(calls, 0); assert.deepEqual(result.value.events, []); assert.equal(result.value.surveyInput, null);
    assert.equal(result.value.facts[0]?.kind, "baseline-established");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const kind of ["web-page", "api-record"] as const) {
  test(`L3-AC1 ${kind} event claims have the complete provenance triple and project without test_output`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
    try {
      const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" });
      const common = { source: source("source-a", { kind }), callbacks };
      assert.equal((await emitter.emit({ ...common, current: observation("snapshot-1", [proposal("old")]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "snapshot-1" } })).ok, true);
      const result = await emitter.emit({ ...common, current: observation("snapshot-2", [proposal("new")]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "snapshot-2" } });
      assert.equal(result.ok, true); if (!result.ok || !result.value.surveyInput) return;
      assert.equal(result.value.surveyInput.rawSources[0]?.kind, kind);
      assert.equal(result.value.surveyInput.rawSources[0]?.resolution, "observation");
      assert.equal(result.value.surveyInput.rawSources[0]?.sourceRef, "snapshot-2");
      assert.deepEqual(result.value.surveyInput.reviewOutcomes, []);
      const claim = result.value.surveyInput.claims[0]!;
      assert.equal(claim.status, "proposed");
      assert.deepEqual(claim.metadata?.priorSnapshotRef, "snapshot-1");
      assert.deepEqual(claim.metadata?.currentSnapshotRef, "snapshot-2");
      const bundle = buildSurveyTrustBundle(result.value.surveyInput);
      assert.equal(bundle.evidence[0]?.metadata?.provenanceResolution, "observation");
      assert.equal(bundle.evidence[0]?.evidenceType, kind === "web-page" ? "crawl_observation" : "source_excerpt");
      assert.equal(bundle.evidence.some((e) => e.evidenceType === "test_output"), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("L3-AC2 forbidden resolutions are rejected before state advances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
  try {
    const store = createObservationStore({ root });
    const emitter = createSurveyEmitter<Entity>({ store, now: () => "2026-07-10T12:00:00.000Z", resolution: "testimony" as "observation" });
    const result = await emitter.emit({ source: source(), current: observation("snapshot-1", []), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "snapshot-1" }, callbacks });
    assert.equal(result.ok, false);
    assert.deepEqual(await store.loadLatest("source-a"), { ok: true, value: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [priorValue, currentValue, expected] of [
  [undefined, "ready", "value-populated"], ["old", "new", "value-updated"], [["a"], ["a", "b"], "items-added"], [["a", "b"], ["a"], "items-removed"], ["old", 1, "value-replaced"],
] as const) {
  test(`L3-AC1 authors field change kind ${expected}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
    try {
      const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
      assert.equal((await emitter.emit({ ...common, current: observation("prior", [proposal(priorValue)]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } })).ok, true);
      const result = await emitter.emit({ ...common, current: observation("current", [proposal(currentValue)]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } });
      assert.equal(result.ok, true); if (!result.ok || !result.value.surveyInput) return; const event = result.value.events[0]; assert.equal(event?.kind, "field-changed"); if (event?.kind === "field-changed") assert.equal(event.changeKind, expected);
      assert.equal(result.value.surveyInput.rawSources[0]?.sourceRef, "current"); assert.equal(result.value.surveyInput.claims[0]?.metadata?.priorSnapshotRef, "prior"); assert.equal(result.value.surveyInput.claims[0]?.metadata?.currentSnapshotRef, "current");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("L3-AC1/L3-AC3 appearance, field removal, removed entity, provenance movement, and occurrence facts retain anchors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
  try {
    const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
    await emitter.emit({ ...common, current: observation("one", []), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "one" } });
    const appearance = await emitter.emit({ ...common, current: observation("two", [proposal("same"), proposal("gone", { fieldPath: "entries[].gone" })]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "two" } });
    assert.equal(appearance.ok, true); if (!appearance.ok) return; assert.equal(appearance.value.events[0]?.kind, "new-entity-appeared");
    const removal = await emitter.emit({ ...common, current: observation("three", [proposal("same", { provenance: { locator: "chars:9-13", excerpt: "same" } })]), check: { checkedAt: "three", resultKind: "changed", currentSnapshotRef: "three" } });
    assert.equal(removal.ok, true); if (!removal.ok || !removal.value.surveyInput) return; const removed = removal.value.events.find((event) => event.kind === "field-changed"); assert.equal(removed?.kind, "field-changed"); if (removed?.kind === "field-changed") assert.equal(removed.current, undefined);
    assert.equal(removal.value.surveyInput.rawSources.find((_, index) => removal.value.events[index] === removed)?.sourceRef, "three");
    const facts = removal.value.facts[0]; assert.equal(facts?.kind, "proposal-set-facts"); if (facts?.kind === "proposal-set-facts") { assert.equal(facts.value.provenanceChanges.length, 1); assert.equal(facts.value.addedProposalOccurrences.length > 0, true); assert.equal(facts.value.removedProposalOccurrences.length > 0, true); }
    const gone = await emitter.emit({ ...common, current: observation("four", []), check: { checkedAt: "four", resultKind: "changed", currentSnapshotRef: "four" } }); assert.equal(gone.ok, true); if (gone.ok) { assert.deepEqual(gone.value.events, []); const fact = gone.value.facts[0]; assert.equal(fact?.kind, "proposal-set-facts"); if (fact?.kind === "proposal-set-facts") assert.deepEqual(fact.value.removedEntities, ["entry-0"]); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, mutate] of [
  ["origin", (input: any) => { input.rawSources[0].kind = "manual-entry"; }],
  ["current sourceRef", (input: any) => { input.rawSources[0].sourceRef = "prior"; }],
  ["proposed status", (input: any) => { input.claims[0].status = "verified"; }],
  ["prior ref", (input: any) => { delete input.claims[0].metadata.priorSnapshotRef; }],
  ["current ref", (input: any) => { delete input.claims[0].metadata.currentSnapshotRef; }],
  ["resolution", (input: any) => { delete input.rawSources[0].resolution; }],
  ["authorization", (input: any) => { input.reviewOutcomes.push({ id: "review", candidateSetId: input.candidateSets[0].id, status: "proposed", authorizing: { kind: "explicit-statement", statement: "yes" } }); }],
  ...["testimony", "supersession", "precedence-selection", "carry-forward"].map((resolution) => [resolution, (input: any) => { input.rawSources[0].resolution = resolution; }] as const),
] as const) {
  test(`L3-AC2 runtime validation rejects mutated ${label} without advancing state`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
    try {
      const store = createObservationStore({ root }); const base = createSurveyEmitter<Entity>({ store, now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
      const first = await base.emit({ ...common, current: observation("prior", [proposal("old")]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } }); assert.equal(first.ok, true); if (!first.ok) return; const before = first.value.committedObservation.observationId;
      const hostile = createSurveyEmitter<Entity>({ store, now: () => "2026-07-10T12:00:01.000Z", transformSurveyInput(input) { const cloned = structuredClone(input); mutate(cloned); return cloned; } });
      const result = await hostile.emit({ ...common, current: observation("current", [proposal("new")]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } }); assert.equal(result.ok, false); const latest = await store.loadLatest("source-a"); assert.equal(latest.ok, true); if (latest.ok) assert.equal(latest.value?.observationId, before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const word of ["testimony", "supersession", "precedence-selection", "carry-forward"] as const) {
  test(`second review: ordinary evidence value ${word} is allowed`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
    try {
      const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
      await emitter.emit({ ...common, current: observation("prior", [proposal("old")]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } });
      const result = await emitter.emit({ ...common, current: observation("current", [proposal(word, { provenance: { locator: word, excerpt: word } })]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } });
      assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.surveyInput?.claims[0]?.value && (result.value.surveyInput.claims[0].value as { currentValue?: unknown }).currentValue, word);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("second review: api-record appearance event carries observation provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
  try {
    const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source("source-a", { kind: "api-record" }), callbacks };
    await emitter.emit({ ...common, current: observation("prior", []), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } });
    const result = await emitter.emit({ ...common, current: observation("current", [proposal("new")]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } });
    assert.equal(result.ok, true); if (!result.ok || !result.value.surveyInput) return; assert.equal(result.value.events[0]?.kind, "new-entity-appeared"); assert.equal(result.value.surveyInput.rawSources[0]?.kind, "api-record"); assert.equal(result.value.surveyInput.rawSources[0]?.resolution, "observation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [priorValue, currentValue, expected] of [
  [undefined, "ready", "value-populated"], ["old", "new", "value-updated"], [["a"], ["a", "b"], "items-added"], [["a", "b"], ["a"], "items-removed"], ["old", 1, "value-replaced"],
] as const) {
  test(`second review: api-record field change ${expected} completes the origin x change-kind matrix`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-emission-"));
    try {
      const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source("source-a", { kind: "api-record" }), callbacks };
      await emitter.emit({ ...common, current: observation("prior", [proposal(priorValue)]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } });
      const result = await emitter.emit({ ...common, current: observation("current", [proposal(currentValue)]), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } }); assert.equal(result.ok, true); if (!result.ok) return; const event = result.value.events[0]; assert.equal(event?.kind, "field-changed"); if (event?.kind === "field-changed") assert.equal(event.changeKind, expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("L3-AC12 equivalent reordered inputs produce stable events, facts, ids, and serialized SurveyInput", async () => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(path.join(os.tmpdir(), "lookout-emission-"))));
  try {
    const outputs = [];
    const left = proposal("old-left", { fieldPath: "entries[].left" }); const right = proposal("old-right", { fieldPath: "entries[].right" });
    const changedLeft = proposal("new-left", { fieldPath: "entries[].left" }); const changedRight = proposal("new-right", { fieldPath: "entries[].right" });
    for (let index = 0; index < roots.length; index += 1) {
      const emitter = createSurveyEmitter<Entity>({ store: createObservationStore({ root: roots[index] }), now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
      await emitter.emit({ ...common, current: observation("prior", index === 0 ? [left, right] : [right, left]), check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: "prior" } });
      const current = index === 0 ? [changedLeft, changedRight] : [changedRight, changedLeft];
      const result = await emitter.emit({ ...common, current: observation("current", current), check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: "current" } }); assert.equal(result.ok, true); if (result.ok) outputs.push({ events: result.value.events, facts: result.value.facts, survey: JSON.stringify(result.value.surveyInput) });
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); }
});
