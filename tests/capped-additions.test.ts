import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { Snapshot } from "@kontourai/forage";
import {
  createPreparedArtifact,
  EXACT_OCCURRENCE_RESOLVER_VERSION,
  enumerateExactOccurrences,
  type ExtractionCoverageEntry,
  type ExtractionProposal,
} from "@kontourai/traverse";
import {
  buildSemanticReviewWork,
  createDriftEmitter,
  createLookoutSnapshotStore,
  createObservationStore,
  type DriftFact,
  type PriorTextPreparation,
  type ProposalDiffEvent,
  type ProposalSetIncompleteness,
  type ProposalSetObservation,
  type SemanticReviewChange,
} from "../src/index.js";
import { source } from "./helpers.js";

// A page that stays capped: each run reads the first two 20-character lines
// (one chunk) and never dispatches the rest. Every run is stored as the
// baseline with its incomplete marker.
const line = (name: string) => `name: ${name}`.padEnd(19, ".") + "\n";
const page = (...names: string[]) => names.map(line).join("");
const READ_END = 40;
const cappedFor = (text: string): ProposalSetIncompleteness => {
  const coverage: ExtractionCoverageEntry[] = [
    { chunk: 1, start: 0, end: READ_END, status: "complete" },
    { chunk: 2, start: READ_END, end: text.length, status: "unread", reason: "not-dispatched" },
  ];
  return { reason: "max-chunks", coverage };
};

// A Traverse-shaped proposal whose excerpt was placed by the exact resolver.
function proposalIn(text: string, name: string): ExtractionProposal {
  const [first] = enumerateExactOccurrences(text, name);
  assert.ok(first, `fixture text must hold ${name}`);
  return {
    fieldPath: "name", candidateValue: name, confidence: 0.9, extractor: "example-extractor:v1",
    provenance: {
      excerpt: name, locator: `chars:${first.start}-${first.end}`,
      occurrence: { resolverVersion: EXACT_OCCURRENCE_RESOLVER_VERSION, count: 1, selected: first, selection: "source-order", hintUsed: false, ambiguous: false },
    },
  };
}

type Entity = { key: string; proposals: readonly ExtractionProposal[] };
const callbacks = {
  // Identity is the name itself: offsets differ between captures.
  selectEntities: (input: ProposalSetObservation): readonly Entity[] => input.proposals.map((item) => ({ key: String(item.candidateValue), proposals: [item] })),
  entityIdentity: (entity: Entity) => entity.key,
  proposalsFor: (entity: Entity) => entity.proposals,
  fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
};

// Caller-owned preparation: this page is served as plain text.
const textPreparation: PriorTextPreparation = {
  prepare: ({ snapshot }) => typeof snapshot.body === "string" ? snapshot.body : new TextDecoder().decode(snapshot.body),
};

async function harness(run: (h: {
  capture(label: string, second: number, text: string, proposed: readonly string[], options?: { complete?: boolean; preparationVersion?: string; bodyPrefix?: string }): Promise<ProposalSetObservation>;
  root: string;
  snapshots: ReturnType<typeof createLookoutSnapshotStore>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-capped-"));
  try {
    const snapshots = createLookoutSnapshotStore(path.join(root, "snapshots"));
    await run({
      root,
      snapshots,
      async capture(label, second, text, proposed, options = {}) {
        const body = (options.bodyPrefix ?? "") + text;
        const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/source-a", status: 200, fetchedAt: `2026-07-10T12:02:${String(second).padStart(2, "0")}.000Z`, body, bodyHash: createHash("sha256").update(body).digest("hex") };
        await snapshots.put(snapshot);
        const snapshotRef = buildSnapshotSourceRef(snapshot);
        return {
          sourceId: "source-a", snapshotRef, observedAt: `${label}-time`,
          proposals: proposed.map((name) => proposalIn(text, name)),
          preparedArtifact: createPreparedArtifact(text, { preparationMode: "text", sourceSnapshotRef: snapshotRef, ...(options.preparationVersion ? { preparationVersion: options.preparationVersion } : {}) }),
          ...(options.complete ? {} : { incomplete: cappedFor(text) }),
        };
      },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const anchor = (current: ProposalSetObservation) => ({ checkedAt: `${current.observedAt}-checked`, resultKind: "changed" as const, currentSnapshotRef: current.snapshotRef });
const eventKeys = (events: readonly ProposalDiffEvent[]) => events.map((event) => `${event.entityKey}:${event.kind}`);
function factOf(facts: readonly DriftFact[]) {
  const fact = facts[0];
  assert.equal(fact?.kind, "proposal-set-facts");
  if (fact?.kind !== "proposal-set-facts") throw new Error("unreachable");
  return fact;
}

describe("a page that stays capped, through the real stores and emitter", () => {
  test("a genuinely new entity inside the read range raises new-entity-appeared", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: textPreparation });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      // Delta is inserted inside the read range; Beta is pushed past the cap.
      const b = await capture("b", 2, page("Alpha", "Delta", "Beta", "Gamma"), ["Alpha", "Delta"]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(eventKeys(result.value.events), ["Delta:new-entity-appeared"]);
      const fact = factOf(result.value.facts);
      assert.deepEqual(fact.priorText, { status: "verified" });
      assert.deepEqual(fact.value.addedProposalEvidence?.map((item) => item.entityKey), ["Delta"]);
      assert.deepEqual(fact.value.newlyObservedEntities, []);
      assert.deepEqual(fact.value.unobservedEntities, ["Beta"]);
      assert.notEqual(result.value.committedObservation, null);
    });
  });

  test("an entity shifted into the read window from beyond the cap does not", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: textPreparation });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      // Beta is removed, so Gamma moves from unread text into the read range.
      const b = await capture("b", 2, page("Alpha", "Gamma"), ["Alpha", "Gamma"]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.events, []);
      const fact = factOf(result.value.facts);
      assert.deepEqual(fact.priorText, { status: "verified" });
      assert.deepEqual(fact.value.newlyObservedEntities, ["Gamma"]);
      assert.deepEqual(fact.value.newlyObservedEntityAnchors, [{ entityKey: "Gamma", anchor: "prior-unread-text" }]);
      assert.deepEqual(fact.value.addedProposalEvidence, []);
    });
  });

  test("text the prior read but did not propose is a proposer difference, kept as a fact", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: textPreparation });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      const b = await capture("b", 2, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.events, []);
      assert.deepEqual(factOf(result.value.facts).value.newlyObservedEntityAnchors, [{ entityKey: "Beta", anchor: "prior-read-text" }]);
    });
  });

  test("an excerpt the exact resolver did not place is not anchored", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: textPreparation });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      const b = await capture("b", 2, page("Alpha", "Delta", "Beta", "Gamma"), ["Alpha", "Delta"]);
      const unplaced = { ...b, proposals: b.proposals.map(({ provenance: { occurrence: _dropped, ...provenance }, ...rest }) => ({ ...rest, provenance })) };
      const result = await emitter.emit({ source: source(), current: unplaced, check: anchor(unplaced), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.events, []);
      assert.deepEqual(factOf(result.value.facts).value.newlyObservedEntityAnchors, [{ entityKey: "Delta", anchor: "unanchorable" }]);
    });
  });

  // Each reason the prior's text cannot be rebuilt keeps Delta a fact and says why.
  const unavailable: readonly [string, (h: { snapshots: ReturnType<typeof createLookoutSnapshotStore> }) => Partial<Parameters<typeof createDriftEmitter<Entity>>[0]>, { preparationVersion?: string }, string][] = [
    ["no preparation configured", () => ({}), {}, "not-configured"],
    ["preparation that rebuilds other text", () => ({ priorText: { prepare: () => page("Alpha", "Beta") } }), {}, "text-mismatch"],
    ["preparation that throws", () => ({ priorText: { prepare: () => { throw new Error("boom"); } } }), {}, "preparation-failed"],
    ["a prior larger than the bound", () => ({ priorText: { ...textPreparation, maxChars: 59 } }), {}, "too-large"],
    ["a current run prepared another way", () => ({ priorText: textPreparation }), { preparationVersion: "other" }, "preparation-changed"],
    ["preparation that never settles", () => ({ priorText: { prepare: () => new Promise<string>(() => {}), timeoutMs: 20 } }), {}, "preparation-timeout"],
    ["preparation that returns no text", () => ({ priorText: { prepare: () => 42 as unknown as string } }), {}, "preparation-failed"],
  ];
  for (const [label, configure, currentOptions, reason] of unavailable) {
    test(`${label}: the new entity stays newly observed, marked ${reason}`, { timeout: 5000 }, async () => {
      await harness(async ({ root, snapshots, capture }) => {
        const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, ...configure({ snapshots }) });
        const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
        assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
        const b = await capture("b", 2, page("Alpha", "Delta", "Beta", "Gamma"), ["Alpha", "Delta"], currentOptions);
        const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
        assert.equal(result.ok, true); if (!result.ok) return;
        assert.deepEqual(result.value.events, []);
        const fact = factOf(result.value.facts);
        assert.deepEqual(fact.priorText, { status: "unavailable", reason });
        assert.deepEqual(fact.value.newlyObservedEntities, ["Delta"]);
        assert.equal(fact.value.newlyObservedEntityAnchors, undefined);
      });
    });
  }

  test("an entity that kept one excerpt of the prior's text stays a fact, even with another excerpt new", async () => {
    // Entities of two proposals: the name and a tag, grouped by pathIndices.
    const grouped = {
      selectEntities: (input: ProposalSetObservation): readonly Entity[] => {
        const byIndex = new Map<number, ExtractionProposal[]>();
        for (const item of input.proposals) { const i = item.pathIndices?.[0] ?? -1; byIndex.set(i, [...(byIndex.get(i) ?? []), item]); }
        return [...byIndex.values()].map((proposals) => ({ key: String(proposals.find((item) => item.fieldPath === "name")?.candidateValue), proposals }));
      },
      entityIdentity: (entity: Entity) => entity.key,
      proposalsFor: (entity: Entity) => entity.proposals,
      fieldIdentity: (_entity: Entity, item: ExtractionProposal) => item.fieldPath,
    };
    const indexed = (observation: ProposalSetObservation, text: string, entities: readonly (readonly [string, string])[]): ProposalSetObservation => ({
      ...observation,
      proposals: entities.flatMap(([name, tag], i) => [{ ...proposalIn(text, name), pathIndices: [i] }, { ...proposalIn(text, tag), fieldPath: "tag", pathIndices: [i] }]),
    });
    await harness(async ({ root, snapshots, capture }) => {
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: textPreparation });
      const aText = page("Alpha", "Beta", "Gamma");
      const a = indexed(await capture("a", 1, aText, []), aText, [["Alpha", "Alpha"]]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks: grouped })).ok, true);
      // Renamed Delta, but its tag Gamma was already in the prior's (unread) text.
      const bText = page("Alpha", "Delta", "Gamma");
      const b = indexed(await capture("b", 2, bText, []), bText, [["Alpha", "Alpha"], ["Delta", "Gamma"]]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks: grouped });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.events.filter((event) => event.kind === "new-entity-appeared"), []);
      const fact = factOf(result.value.facts);
      assert.deepEqual(fact.priorText, { status: "verified" });
      assert.deepEqual(fact.value.newlyObservedEntityAnchors, [{ entityKey: "Delta", anchor: "prior-unread-text" }]);
    });
  });

  test("a snapshot body over the bound is not prepared, even when its prepared text is within it", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      const prefix = "<!-- wrapper -->";
      let prepared = 0;
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: { maxChars: 60, prepare: ({ snapshot }) => { prepared += 1; return String(snapshot.body).slice(prefix.length); } } });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"], { bodyPrefix: prefix });
      assert.equal(a.preparedArtifact?.contentLength, 60);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      const b = await capture("b", 2, page("Alpha", "Delta", "Beta", "Gamma"), ["Alpha", "Delta"]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(result.value.events, []);
      assert.deepEqual(factOf(result.value.facts).priorText, { status: "unavailable", reason: "too-large" });
      assert.equal(prepared, 0);
    });
  });

  test("with no new entity to anchor, the prior's text is not rebuilt", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      let prepared = 0;
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: { prepare: (input) => { prepared += 1; return textPreparation.prepare(input); } } });
      const a = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      const b = await capture("b", 2, page("Alpha", "Beta", "Gamma", "Omega"), ["Alpha", "Beta"]);
      const result = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.deepEqual(factOf(result.value.facts).priorText, { status: "not-needed" });
      assert.equal(prepared, 0);
    });
  });

  test("a prior stored without a prepared artifact is marked, and a complete prior needs no text", async () => {
    await harness(async ({ root, snapshots, capture }) => {
      let prepared = 0;
      const emitter = createDriftEmitter<Entity>({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: snapshots, priorText: { prepare: (input) => { prepared += 1; return textPreparation.prepare(input); } } });
      const { preparedArtifact: _dropped, ...a } = await capture("a", 1, page("Alpha", "Beta", "Gamma"), ["Alpha", "Beta"]);
      assert.equal((await emitter.emit({ source: source(), current: a, check: anchor(a), callbacks })).ok, true);
      const b = await capture("b", 2, page("Alpha", "Delta", "Beta"), ["Alpha", "Delta", "Beta"], { complete: true });
      const second = await emitter.emit({ source: source(), current: b, check: anchor(b), callbacks });
      assert.equal(second.ok, true); if (!second.ok) return;
      assert.deepEqual(factOf(second.value.facts).priorText, { status: "unavailable", reason: "no-prepared-artifact" });
      const c = await capture("c", 3, page("Alpha", "Delta", "Beta", "Omega"), ["Alpha", "Delta", "Beta", "Omega"], { complete: true });
      const third = await emitter.emit({ source: source(), current: c, check: anchor(c), callbacks });
      assert.equal(third.ok, true); if (!third.ok) return;
      assert.deepEqual(eventKeys(third.value.events), ["Omega:new-entity-appeared"]);
      assert.equal(factOf(third.value.facts).priorText, undefined);
      assert.equal(prepared, 0);
    });
  });
});

describe("the stored prepared artifact", () => {
  test("round-trips through the observation store and a malformed one is refused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-capped-"));
    try {
      const store = createObservationStore({ root });
      const artifact = createPreparedArtifact("text", { preparationMode: "text", sourceSnapshotRef: "snapshot-1" });
      const record = (preparedArtifact: unknown) => ({ observation: { sourceId: "source-a", snapshotRef: "snapshot-1", observedAt: "observed", proposals: [], preparedArtifact: preparedArtifact as typeof artifact }, recordedAt: "recorded", check: { checkedAt: "checked", resultKind: "changed" as const, currentSnapshotRef: "snapshot-1" } });
      assert.equal((await store.commit(record({ ...artifact, ref: "not-a-ref" }), null)).ok, false);
      assert.equal((await store.commit(record({ ...artifact, sourceSnapshotRef: "another-snapshot" }), null)).ok, false);
      const committed = await store.commit(record(artifact), null);
      assert.equal(committed.ok, true);
      const loaded = await store.loadLatest("source-a");
      assert.equal(loaded.ok, true); if (!loaded.ok) return;
      assert.deepEqual(loaded.value?.preparedArtifact, artifact);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("an unread coverage entry's reason", () => {
  test("outside Traverse's reasons is refused on commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-capped-"));
    try {
      const store = createObservationStore({ root });
      const record = (reason: string) => ({ observation: { sourceId: "source-a", snapshotRef: "snapshot-1", observedAt: "observed", proposals: [], incomplete: { reason: "max-chunks", coverage: [{ chunk: 1, start: 0, end: 10, status: "unread", reason }] } as unknown as ProposalSetIncompleteness }, recordedAt: "recorded", check: { checkedAt: "checked", resultKind: "changed" as const, currentSnapshotRef: "snapshot-1" } });
      const refused = await store.commit(record("made-up-reason"), null);
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.match(refused.error.message, /incompleteness is malformed/);
      assert.equal((await store.commit(record("not-dispatched"), null)).ok, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("semantic review work against an incomplete prior", () => {
  const text = page("Alpha", "Beta", "Gamma");
  const later = page("Alpha", "Delta", "Beta", "Gamma");
  const observation = (snapshotRef: string, body: string, names: readonly string[]): ProposalSetObservation =>
    ({ sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-at`, proposals: names.map((name) => proposalIn(body, name)), incomplete: cappedFor(body) });
  const build = (extras: Record<string, unknown> = {}) => buildSemanticReviewWork({
    prior: observation("snapshot-prior", text, ["Alpha", "Beta"]),
    current: observation("snapshot-current", later, ["Alpha", "Delta"]),
    observationIdentity: { prior: "observation-prior", current: "observation-current" },
    ...callbacks,
    claimTarget: (change: SemanticReviewChange) => ({ subjectType: "record", subjectId: change.entityKey, facet: "public-data", claimType: "field-value", fieldOrBehavior: change.fieldPath, impactLevel: "medium" }),
    ...extras,
  });
  const kinds = (result: ReturnType<typeof build>) => {
    assert.equal(result.ok, true);
    return result.ok ? result.value.items.map((item) => `${item.spec.candidates[1]?.value}:${item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind}`) : [];
  };

  test("a newly observed proposal on a capped-to-capped pair is review work", () => {
    assert.deepEqual(kinds(build()), ["Delta:proposal-newly-observed"]);
  });

  test("with the prior's text, an entity absent from it is an added proposal", () => {
    assert.deepEqual(kinds(build({ priorPreparedText: text })), ["Delta:proposal-added"]);
  });
});
