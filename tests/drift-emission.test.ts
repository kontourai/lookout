import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ExactSnapshotStore, Snapshot } from "@kontourai/forage";
import type { ExtractionProposal } from "@kontourai/traverse";
import { createDriftEmitter, createObservationStore, type ObservationStore, type ProposalSetObservation } from "../src/index.js";
import { source } from "./helpers.js";

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const proposal = (value: unknown, overrides: Partial<ExtractionProposal> = {}): ExtractionProposal => ({
  fieldPath: "entries[].value", pathIndices: [0], candidateValue: value, confidence: 0.9,
  provenance: { locator: "chars:0-5", excerpt: String(value) }, extractor: "example-extractor:v1", ...overrides,
});
const snapshots = new Map<string, Snapshot>();
const admissionStore: ExactSnapshotStore = {
  async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; },
  async findExact(reference) {
    const snapshot = snapshots.get(`${reference.sourceId}:${reference.bodyHash}:${reference.fetchedAt}`);
    return snapshot ? { kind: "found", snapshot } : { kind: "missing" };
  },
};
const observation = (label: string, proposals: readonly ExtractionProposal[]): ProposalSetObservation => {
  const body = `body:${label}`;
  const second = createHash("sha256").update(label).digest()[0]! % 60;
  const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:00:${String(second).padStart(2, "0")}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
  snapshots.set(`${snapshot.sourceId}:${snapshot.bodyHash}:${snapshot.fetchedAt}`, snapshot);
  return { sourceId: "source-a", snapshotRef: buildSnapshotSourceRef(snapshot), observedAt: `${label}-time`, proposals };
};
const anchor = (observation: ProposalSetObservation, checkedAt: string) => ({ checkedAt, resultKind: "changed" as const, currentSnapshotRef: observation.snapshotRef });
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

test("first observation is a fact-only baseline, does not call diff, and has a null priorObservationId", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-drift-"));
  try {
    let calls = 0;
    const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore: admissionStore, diff: () => { calls++; throw new Error("must not run"); }, now: () => "2026-07-10T12:00:00.000Z" });
    const current = observation("snapshot-1", [proposal("old")]); const result = await emitter.emit({ source: source(), current, check: anchor(current, "checked"), callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(calls, 0);
    assert.deepEqual(result.value.events, []);
    assert.equal(result.value.priorObservationId, null);
    assert.equal(result.value.facts[0]?.kind, "baseline-established");
    assert.equal(result.value.committedObservation.snapshotRef, current.snapshotRef);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a genuine change produces proposal-set-facts, non-empty events, and a set priorObservationId", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-drift-"));
  try {
    const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
    const common = { source: source(), callbacks };
    const initial = observation("snapshot-1", [proposal("old")]); const first = await emitter.emit({ ...common, current: initial, check: anchor(initial, "one") });
    assert.equal(first.ok, true); if (!first.ok) return;
    const current = observation("snapshot-2", [proposal("new")]); const result = await emitter.emit({ ...common, current, check: anchor(current, "two") });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.value.priorObservationId, first.value.committedObservation.observationId);
    assert.notEqual(result.value.events.length, 0);
    const event = result.value.events[0]; assert.equal(event?.kind, "field-changed");
    if (event?.kind === "field-changed") assert.equal(event.changeKind, "value-updated");
    const fact = result.value.facts[0]; assert.equal(fact?.kind, "proposal-set-facts");
    if (fact?.kind === "proposal-set-facts") { assert.equal(fact.priorSnapshotRef, initial.snapshotRef); assert.equal(fact.currentSnapshotRef, current.snapshotRef); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("equivalent reordered inputs produce stable events, facts, and ids", async () => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(path.join(os.tmpdir(), "lookout-drift-"))));
  try {
    const outputs = [];
    const left = proposal("old-left", { fieldPath: "entries[].left" }); const right = proposal("old-right", { fieldPath: "entries[].right" });
    const changedLeft = proposal("new-left", { fieldPath: "entries[].left" }); const changedRight = proposal("new-right", { fieldPath: "entries[].right" });
    for (let index = 0; index < roots.length; index += 1) {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: roots[index] }), snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" }); const common = { source: source(), callbacks };
      const prior = observation("prior", index === 0 ? [left, right] : [right, left]); await emitter.emit({ ...common, current: prior, check: anchor(prior, "one") });
      const current = index === 0 ? [changedLeft, changedRight] : [changedRight, changedLeft];
      const next = observation("current", current); const result = await emitter.emit({ ...common, current: next, check: anchor(next, "two") });
      assert.equal(result.ok, true); if (result.ok) outputs.push({ events: result.value.events, facts: result.value.facts });
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); }
});

test("a diff callback that throws or returns an error result yields diff-error and does not advance state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-drift-"));
  try {
    const store = createObservationStore({ root });
    const seed = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
    const common = { source: source(), callbacks };
    const prior = observation("prior", [proposal("old")]); const first = await seed.emit({ ...common, current: prior, check: anchor(prior, "one") });
    assert.equal(first.ok, true); if (!first.ok) return;

    const throwing = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:01.000Z", diff: () => { throw new Error("diff blew up"); } });
    const changed = observation("current", [proposal("new")]); const threw = await throwing.emit({ ...common, current: changed, check: anchor(changed, "two") });
    assert.equal(threw.ok, false); if (threw.ok) return; assert.equal(threw.error.kind, "diff-error");

    const failing = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:02.000Z", diff: () => ({ ok: false, error: { message: "diff refused" } }) });
    const retry = observation("current", [proposal("new")]); const failed = await failing.emit({ ...common, current: retry, check: anchor(retry, "two") });
    assert.equal(failed.ok, false); if (failed.ok) return; assert.equal(failed.error.kind, "diff-error");

    const latest = await store.loadLatest("source-a");
    assert.equal(latest.ok, true); if (latest.ok) assert.equal(latest.value?.observationId, first.value.committedObservation.observationId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failing prior-state read yields prior-state-error", async () => {
  const failingStore: ObservationStore = {
    async loadLatest() { return { ok: false, error: { kind: "corrupt-state", message: "prior state is corrupt" } }; },
    async commit() { throw new Error("commit must not be called"); },
  };
  const emitter = createDriftEmitter<Entity>({ store: failingStore, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
  const current = observation("snapshot-1", [proposal("old")]); const result = await emitter.emit({ source: source(), current, check: anchor(current, "checked"), callbacks });
  assert.equal(result.ok, false); if (result.ok) return;
  assert.equal(result.error.kind, "prior-state-error");
});

test("a failing commit yields persistence-error without changing the emitted facts", async () => {
  const failingCommitStore: ObservationStore = {
    async loadLatest() { return { ok: true, value: null }; },
    async commit() { return { ok: false, error: { kind: "io-error", message: "disk full" } }; },
  };
  const emitter = createDriftEmitter<Entity>({ store: failingCommitStore, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
  const current = observation("snapshot-1", [proposal("old")]); const result = await emitter.emit({ source: source(), current, check: anchor(current, "checked"), callbacks });
  assert.equal(result.ok, false); if (result.ok) return;
  assert.equal(result.error.kind, "persistence-error");
});

test("a successful emission's committedObservation matches what the store now holds as latest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-drift-"));
  try {
    const store = createObservationStore({ root });
    const emitter = createDriftEmitter<Entity>({ store, snapshotStore: admissionStore, now: () => "2026-07-10T12:00:00.000Z" });
    const current = observation("snapshot-1", [proposal("old")]); const result = await emitter.emit({ source: source(), current, check: anchor(current, "checked"), callbacks });
    assert.equal(result.ok, true); if (!result.ok) return;
    const latest = await store.loadLatest("source-a");
    assert.equal(latest.ok, true); if (!latest.ok) return;
    assert.deepEqual(latest.value, result.value.committedObservation);
  } finally { await rm(root, { recursive: true, force: true }); }
});
