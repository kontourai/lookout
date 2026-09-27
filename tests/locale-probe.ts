// Child-process probe for tests/locale-determinism.test.ts. The parent runs it
// under different LC_ALL values; Node's ICU takes its default collation locale
// from the environment, so localeCompare in this process follows that locale.
// Usage: node dist/tests/locale-probe.js <summary|write|read|legacy> [root]
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ExactSnapshotStore, Snapshot } from "@kontourai/forage";
import type { ExtractionProposal } from "@kontourai/traverse";
import {
  createDriftEmitter,
  createObservationStore,
  diffProposalSets,
  type ProposalDiffEvent,
  type ProposalObservationRecordInput,
  type ProposalSetObservation,
} from "../src/index.js";
import { source } from "./helpers.js";

const proposal = (value: unknown, excerpt: string, start: number): ExtractionProposal => ({
  fieldPath: "entries[].value", pathIndices: [0], candidateValue: value, confidence: 0.9,
  extractor: "example-extractor:v1", provenance: { excerpt, locator: `chars:${String(start)}-${String(start + 2)}` },
});

// Non-ASCII string values ("Äa" sorts before "Zz" under en_US, after it under
// sv_SE, and after it by code unit) plus an object value whose keys are
// integer-like, mixed-case and non-ASCII.
export const fixtureProposals: readonly ExtractionProposal[] = [
  proposal("Zz", "Zz", 0),
  proposal("Äa", "Äa", 2),
  proposal({ b: 1, "10": 2, "9": 3, "äb": 4, zb: 5, B: 6 }, "object", 4),
];

const recordInput = (snapshotRef: string, proposals: readonly ExtractionProposal[]): ProposalObservationRecordInput => ({
  observation: { sourceId: "source-a", snapshotRef, observedAt: "2026-01-01T00:00:00.000Z", proposals },
  recordedAt: "2026-01-01T00:00:01.000Z",
  check: { checkedAt: "2026-01-01T00:00:00.500Z", resultKind: "changed", currentSnapshotRef: snapshotRef },
});

async function observationId(): Promise<{ id: string; storedValues: unknown[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-locale-"));
  try {
    const committed = await createObservationStore({ root }).commit(recordInput("snapshot-locale", fixtureProposals), null);
    if (!committed.ok) throw new Error(committed.error.message);
    return { id: committed.value.observationId, storedValues: committed.value.proposals.map((item) => item.candidateValue) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const callbacks = {
  selectEntities: (input: ProposalSetObservation): readonly Entity[] => [{ key: "entry-0", proposals: input.proposals }],
  entityIdentity: (entity: Entity) => entity.key,
  proposalsFor: (entity: Entity) => entity.proposals,
  fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
};

// Two prior and two current values of one field are paired in sorted order, so
// the pairing shows which order the sort produced.
function pairing(): unknown {
  const observe = (snapshotRef: string, proposals: readonly ExtractionProposal[]): ProposalSetObservation =>
    ({ sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-time`, proposals });
  const diffed = diffProposalSets({
    prior: observe("prior", [proposal("Äa", "Äa", 0), proposal("Zz", "Zz", 0)]),
    current: observe("current", [proposal("Bb", "Bb", 0), proposal("Cc", "Cc", 0)]),
    ...callbacks,
  });
  if (!diffed.ok) throw new Error(diffed.error.message);
  return diffed.value.events.map((event) => event.kind === "field-changed" ? [event.prior?.value, event.current?.value] : event.kind);
}

// A diff callback returns events in a fixed order; the emitter re-sorts them.
async function driftOrder(): Promise<unknown> {
  const snapshots = new Map<string, Snapshot>();
  const snapshotStore: ExactSnapshotStore = {
    async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; },
    async findExact(reference) {
      const found = snapshots.get(`${reference.sourceId}:${reference.bodyHash}:${reference.fetchedAt}`);
      return found ? { kind: "found", snapshot: found } : { kind: "missing" };
    },
  };
  const observe = (label: string, second: number): ProposalSetObservation => {
    const body = `body:${label}`;
    const captured: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:00:0${String(second)}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
    snapshots.set(`${captured.sourceId}:${captured.bodyHash}:${captured.fetchedAt}`, captured);
    return { sourceId: "source-a", snapshotRef: buildSnapshotSourceRef(captured), observedAt: `${label}-time`, proposals: [proposal("Zz", "Zz", 0)] };
  };
  const events = [
    { kind: "field-changed", fieldKey: "Äa" },
    { kind: "field-changed", fieldKey: "Zz" },
    { kind: "value-keys", "ä": 1, z: 2 },
    { kind: "value-keys", "ä": 2, z: 1 },
    { kind: "case-keys", a: 1, B: 2 },
    { kind: "case-keys", a: 2, B: 1 },
  ] as unknown as ProposalDiffEvent[];
  const empty = { retainedProposalOccurrences: [], addedProposalOccurrences: [], removedProposalOccurrences: [], provenanceChanges: [], removedEntities: [] };
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-locale-"));
  try {
    const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root }), snapshotStore, now: () => "2026-07-10T12:00:00.000Z", diff: () => ({ ok: true, value: { events, facts: empty } }) });
    const first = observe("one", 1);
    const baseline = await emitter.emit({ source: source(), current: first, check: { checkedAt: "one", resultKind: "changed", currentSnapshotRef: first.snapshotRef }, callbacks });
    if (!baseline.ok) throw new Error(baseline.error.message);
    const second = observe("two", 2);
    const result = await emitter.emit({ source: source(), current: second, check: { checkedAt: "two", resultKind: "changed", currentSnapshotRef: second.snapshotRef }, callbacks });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.events;
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function legacy(): Promise<unknown> {
  const fixture = fileURLToPath(new URL("../../tests/fixtures/legacy-v1-observations", import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-legacy-"));
  try {
    await cp(fixture, root, { recursive: true });
    const store = createObservationStore({ root });
    const loaded = await store.loadLatest("source-a");
    if (!loaded.ok) return { load: loaded.error.kind, message: loaded.error.message };
    if (loaded.value === null) return { load: "missing" };
    const committed = await store.commit(recordInput("snapshot-next", [proposal("Äa", "Äa", 0)]), loaded.value.observationId);
    const reloaded = await store.loadLatest("source-a");
    return {
      load: "ok", version: loaded.value.version, id: loaded.value.observationId,
      commit: committed.ok ? { version: committed.value.version } : committed.error.kind,
      reload: reloaded.ok && reloaded.value ? { version: reloaded.value.version, id: reloaded.value.observationId } : "failed",
    };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const [mode, root] = process.argv.slice(2);
const collation = Math.sign("Ä".localeCompare("Z"));
let output: unknown;
if (mode === "summary") {
  output = { collation, observation: await observationId(), pairing: pairing(), drift: await driftOrder() };
} else if (mode === "write" && root) {
  const committed = await createObservationStore({ root }).commit(recordInput("snapshot-locale", fixtureProposals), null);
  output = { collation, write: committed.ok ? committed.value.observationId : committed.error.kind };
} else if (mode === "read" && root) {
  const loaded = await createObservationStore({ root }).loadLatest("source-a");
  output = { collation, read: loaded.ok ? loaded.value?.observationId ?? null : `${loaded.error.kind}: ${loaded.error.message}` };
} else if (mode === "legacy") {
  output = { collation, legacy: await legacy() };
} else {
  throw new Error(`unknown probe mode ${String(mode)}`);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
