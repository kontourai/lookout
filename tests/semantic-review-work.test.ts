import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractionProposal } from "@kontourai/traverse";
import { buildSemanticReviewWork, type ProposalSetObservation, type SemanticReviewChange } from "../src/index.js";

const proposal = (fieldPath: string, candidateValue: unknown, overrides: Partial<ExtractionProposal> = {}): ExtractionProposal => ({
  fieldPath,
  pathIndices: [0],
  candidateValue,
  confidence: 0.9,
  provenance: { locator: "chars:0-5", excerpt: "value" },
  extractor: "example-extractor:v1",
  ...overrides,
});

const observation = (snapshotRef: string, proposals: readonly ExtractionProposal[]): ProposalSetObservation => ({
  sourceId: "source-example",
  snapshotRef,
  observedAt: `${snapshotRef}-at`,
  proposals,
});

type Entity = { key: string; proposals: ExtractionProposal[] };
function entities(input: ProposalSetObservation): Entity[] {
  const grouped = new Map<number, ExtractionProposal[]>();
  for (const item of input.proposals) {
    const index = item.pathIndices?.[0] ?? -1;
    grouped.set(index, [...(grouped.get(index) ?? []), item]);
  }
  return [...grouped].map(([index, proposals]) => ({ key: `entity-${index}`, proposals }));
}

function project(prior: ExtractionProposal[], current: ExtractionProposal[], extras: Record<string, unknown> = {}) {
  return buildSemanticReviewWork({
    prior: observation("snapshot-prior", prior),
    current: observation("snapshot-current", current),
    observationIdentity: { prior: "observation-prior", current: "observation-current" },
    selectEntities: entities,
    entityIdentity: (entity) => entity.key,
    proposalsFor: (entity) => entity.proposals,
    fieldIdentity: (_entity, item) => item.fieldPath,
    claimTarget: (change: SemanticReviewChange) => ({ subjectType: "record", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
    ...extras,
  });
}

function kinds(result: ReturnType<typeof project>): string[] {
  assert.equal(result.ok, true);
  return result.ok ? result.value.items.map((item) => item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind) : [];
}

describe("semantic proposal review projection", () => {
  test("creates distinct added, removed, moved, and value-changed work", () => {
    const prior = [proposal("record.keep", "old"), proposal("record.remove", "gone"), proposal("record.move", "same", { provenance: { locator: "chars:10-14", excerpt: "same" } })];
    const current = [proposal("record.keep", "new"), proposal("record.add", "added"), proposal("record.move", "same", { provenance: { locator: "chars:20-24", excerpt: "same" } })];
    assert.deepEqual(kinds(project(prior, current)).sort(), ["proposal-added", "proposal-moved", "proposal-removed", "proposal-value-changed"]);
  });

  test("keeps removed evidence and the new observation absence reviewable", () => {
    const result = project([proposal("record.value", "gone")], []);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [item] = result.value.items;
    assert.equal(item?.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind, "proposal-removed");
    assert.equal(item?.spec.candidates[0]?.value, "gone");
    assert.deepEqual(item?.spec.candidates[0]?.locator, { scheme: "text-span", locator: "chars:0-5", excerpt: "value" });
    assert.equal(item?.spec.candidates[1]?.value, null);
    assert.equal(item?.spec.candidates[1]?.source.sourceRef, "snapshot-current");
    assert.equal(item?.spec.candidates[1]?.producer["lookout.kontourai.io/semantic-transition"].evidenceState, "absent");
  });

  test("stable proposals across cosmetic source churn create no work", () => {
    assert.deepEqual(kinds(project([proposal("record.value", "same")], [proposal("record.value", "same")])), []);
  });

  test("duplicate field occurrences match by semantic content rather than input order", () => {
    const left = proposal("record.value", "left", { provenance: { locator: "chars:0-4", excerpt: "left" } });
    const right = proposal("record.value", "right", { provenance: { locator: "chars:5-10", excerpt: "right" } });
    assert.deepEqual(kinds(project([left, right], [right, left])), []);
  });

  test("new coverage and provenance gaps are explicit", () => {
    const schema = [{ path: "record.value", type: "string" as const, required: true }, { path: "record.optional", type: "string" as const }];
    assert.deepEqual(kinds(project([proposal("record.value", "same")], [], { schema })), ["proposal-removed", "coverage-gap"]);
    const prior = proposal("record.value", "same", { provenance: { locator: "chars:0-4", excerpt: "same" } });
    const current = proposal("record.value", "same", { provenance: { locator: "", excerpt: "" } });
    assert.deepEqual(kinds(project([prior], [current])), ["provenance-gap"]);
    assert.deepEqual(kinds(project([], [current])), ["provenance-gap"]);
    const excerptChanged = proposal("record.value", "same", { provenance: { locator: "chars:0-4", excerpt: "edit" } });
    assert.deepEqual(kinds(project([prior], [excerptChanged])), ["proposal-provenance-changed"]);
  });

  test("identical repeated changes receive distinct deterministic item and nested identities", () => {
    const duplicate = proposal("record.value", "same", { pathIndices: [0] });
    const first = project([], [duplicate, { ...duplicate }]);
    const replay = project([], [duplicate, { ...duplicate }]);
    assert.deepEqual(replay, first);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.items.length, 2);
    assert.notEqual(first.value.items[0]?.metadata.name, first.value.items[1]?.metadata.name);
    assert.notEqual(first.value.items[0]?.spec.candidates[0]?.id, first.value.items[1]?.spec.candidates[0]?.id);
    assert.notEqual(first.value.items[0]?.spec.candidates[0]?.extraction.extractionId, first.value.items[1]?.spec.candidates[0]?.extraction.extractionId);
  });

  test("replay is byte-for-byte idempotent and identities bind both observations", () => {
    const first = project([proposal("record.value", "old")], [proposal("record.value", "new")]);
    const second = project([proposal("record.value", "old")], [proposal("record.value", "new")]);
    assert.deepEqual(second, first);
    assert.equal(first.ok, true);
    if (first.ok) {
      const producer = first.value.items[0]?.metadata.producer["lookout.kontourai.io/semantic-transition"];
      assert.equal(producer?.priorObservationId, "observation-prior");
      assert.equal(producer?.currentObservationId, "observation-current");
    }
  });

  test("contains callbacks and rejects credential-shaped observation identities", () => {
    const thrown = project([], [proposal("record.value", "new")], { claimTarget: () => { throw new Error("authorization=secret"); } });
    assert.equal(thrown.ok, false);
    if (!thrown.ok) assert.equal(thrown.error.kind, "callback-threw");
    const rejected = buildSemanticReviewWork({
      prior: observation("prior", []), current: observation("current", []),
      observationIdentity: { prior: "token=secret-value", current: "safe" },
      selectEntities: entities, entityIdentity: (entity) => entity.key, proposalsFor: (entity) => entity.proposals,
      fieldIdentity: (_entity, item) => item.fieldPath,
      claimTarget: () => ({ subjectType: "record", subjectId: "one", facet: "public-data", claimType: "field-value", fieldOrBehavior: "value", impactLevel: "low" }),
    });
    assert.equal(rejected.ok, false);
    assert.equal(JSON.stringify(thrown).includes("authorization=secret"), false);
    const deepThrown = project([], [], { selectEntities: () => { throw new Error("password=deep-secret"); } });
    assert.equal(deepThrown.ok, false);
    assert.equal(JSON.stringify(deepThrown).includes("deep-secret"), false);
    if (!deepThrown.ok) assert.equal(Object.hasOwn(deepThrown.error, "cause"), false);
    const rejectedCallback = project([proposal("record.value", "same")], [proposal("record.value", "same")], { entityIdentity: () => ({ ok: false, error: { kind: "unsupported-value", message: "api-key=rejected-secret", path: "$.authorization=bearer-secret" } }) });
    assert.equal(rejectedCallback.ok, false);
    assert.equal(JSON.stringify(rejectedCallback).includes("rejected-secret"), false);
    assert.equal(JSON.stringify(rejectedCallback).includes("bearer-secret"), false);
    if (!rejectedCallback.ok) assert.equal(Object.hasOwn(rejectedCallback.error, "path"), false);
  });
});
