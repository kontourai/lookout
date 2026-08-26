import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchSource, buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createRequire } from "node:module";
import type { ExactSnapshotStore, Snapshot } from "@kontourai/forage";
import { admitProposalObservation, createDriftEmitter, createLookoutSnapshotStore, createObservationStore } from "../src/index.js";
import { source } from "./helpers.js";

const proposal = { fieldPath: "title", candidateValue: "x", confidence: 1, provenance: { locator: "chars:0-1", excerpt: "x" }, extractor: "test" };
function input(snapshotRef: string) { return { source: source("source-a", { url: "https://example.test/start#fragment" }), current: { sourceId: "source-a", snapshotRef, observedAt: "2026-08-26T00:00:00.000Z", proposals: [proposal] }, check: { checkedAt: "2026-08-26T00:00:00.000Z", resultKind: "changed" as const, currentSnapshotRef: snapshotRef } }; }

test("admission authenticates an actual Forage same-host redirect capture and exposes metadata only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-admission-"));
  try {
    const visited: string[] = [];
    const result = await fetchSource({ id: "source-a", url: "https://example.test/start#fragment", respectRobots: false, retries: 0, egress: { guarded: false } }, {
      clock: () => "2026-08-26T00:00:00.000Z",
      fetch: async (url) => { visited.push(url); return new URL(url).pathname === "/start" ? new Response(null, { status: 302, headers: { location: "/final?x=1" } }) : new Response("body", { status: 200 }); },
    });
    assert.ok(result.snapshot); const snapshot = result.snapshot!;
    assert.deepEqual(visited, ["https://example.test/start#fragment", "https://example.test/final?x=1"]);
    assert.deepEqual(snapshot.redirects, ["https://example.test/start#fragment"]);
    const store = createLookoutSnapshotStore(root); await store.put(snapshot);
    const admitted = await admitProposalObservation({ ...input(buildSnapshotSourceRef(snapshot)), prior: null, snapshotStore: store });
    assert.equal(admitted.ok, true); if (!admitted.ok) return;
    assert.equal(admitted.value.current.integrity, "snapshot-envelope");
    assert.deepEqual(Object.keys(admitted.value.current).sort(), ["bodyHash", "fetchedAt", "integrity", "snapshotDigest", "snapshotRef", "sourceId", "url"]);
    assert.equal(admitted.value.current.url, "https://example.test/final?x=1");
    assert.equal(admitted.value.current.snapshotDigest, buildSnapshotSourceRef(snapshot).match(/snapshotSha256=([a-f0-9]{64})/)?.[1]);
    // Lookout remains trust-layer independent: this dev-only consumer proof
    // lifts the actual emitted baseline fact and asserts successful schema
    // compilation with every sibling Hachure schema registered.
    const emitted = await createDriftEmitter({ store: createObservationStore({ root: path.join(root, "observations") }), snapshotStore: store }).emit({ ...input(buildSnapshotSourceRef(snapshot)), callbacks: { selectEntities: () => [], entityIdentity: () => "entity", proposalsFor: () => [], fieldIdentity: () => "field" } });
    assert.equal(emitted.ok, true); if (!emitted.ok) return;
    const fact = emitted.value.facts[0]!;
    assert.equal(fact.kind, "baseline-established"); if (fact.kind !== "baseline-established") return;
    const require = createRequire(import.meta.url); const Ajv2020 = require("ajv/dist/2020.js") as new (options: { strict: boolean }) => { addSchema(schema: object): void; addFormat(...args: unknown[]): unknown; getSchema(id: string): ((value: unknown) => boolean) | undefined };
    const { schemas } = await import("hachure") as { schemas: Map<string, object> };
    const ajv = new Ajv2020({ strict: false }); (require("ajv-formats") as (value: typeof ajv) => void)(ajv); for (const schema of schemas.values()) ajv.addSchema(schema);
    const validate = ajv.getSchema("https://hachure.org/schemas/evidence.schema.json");
    assert.ok(validate, "Hachure evidence validator compiled");
    assert.equal(validate({ id: "lookout:baseline", claimId: "drift:source-a", evidenceType: "runtime_observation", method: fact.resolution, sourceRef: fact.snapshotRef, excerptOrSummary: "baseline established", observedAt: fact.observedAt, collectedBy: "lookout" }), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed current reference is rejected before snapshot or observation-store I/O", async () => {
  let snapshotReads = 0; let observationReads = 0;
  const snapshots: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact() { snapshotReads++; return { kind: "missing" }; } };
  const observations = { async loadLatest() { observationReads++; return { ok: true as const, value: null }; }, async commit() { throw new Error("must not commit"); } };
  const emitter = createDriftEmitter({ store: observations, snapshotStore: snapshots });
  const bad = "forage-snapshot:source-a?url=https%3A%2F%2Fexample.test%2Fsource-a&sha256=deadbeef&fetchedAt=now";
  const result = await emitter.emit({ ...input(bad), callbacks: { selectEntities: () => [], entityIdentity: () => "x", proposalsFor: () => [], fieldIdentity: () => "x" } });
  assert.equal(result.ok, false); assert.equal(snapshotReads, 0); assert.equal(observationReads, 0);
});

test("emitter commits the invocation image when caller mutates current ref, anchor, and nested proposals while admission is deferred", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-admission-race-"));
  try {
    const body = "race"; const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/start", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex") };
    const reference = buildSnapshotSourceRef(snapshot); let calls = 0; let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const snapshots: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact() { calls++; if (calls === 2) await paused; return { kind: "found", snapshot }; } };
    const store = createObservationStore({ root }); const document = input(reference);
    const emitter = createDriftEmitter({ store, snapshotStore: snapshots });
    const pending = emitter.emit({ ...document, callbacks: { selectEntities: () => [], entityIdentity: () => "entity", proposalsFor: () => [], fieldIdentity: () => "field" } });
    while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
    (document.current as { snapshotRef: string }).snapshotRef = "forage-snapshot:source-a?url=https%3A%2F%2Fexample.test%2Fstart&sha256=deadbeef&fetchedAt=now";
    (document.check as { currentSnapshotRef: string }).currentSnapshotRef = document.current.snapshotRef;
    (document.current.proposals[0] as { candidateValue: string }).candidateValue = "mutated";
    release(); const result = await pending;
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.value.committedObservation.snapshotRef, reference);
    assert.equal(result.value.committedObservation.proposals[0]?.candidateValue, "x");
    const latest = await store.loadLatest("source-a"); assert.equal(latest.ok, true); if (latest.ok) assert.equal(latest.value?.snapshotRef, reference);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public admission retains the current source, URL, ref, and anchor captured before deferred resolution", async () => {
  const body = "current-capture";
  const snapshot: Snapshot = { sourceId: "source-a", url: "https://example.test/start", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex") };
  const reference = buildSnapshotSourceRef(snapshot); let started!: () => void; let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const snapshots: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact() { started(); await waiting; return { kind: "found", snapshot }; } };
  const document = { ...input(reference), prior: null, snapshotStore: snapshots };
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const pending = admitProposalObservation(document);
  await begun;
  const bad = "forage-snapshot:deadbeef?url=https%3A%2F%2Fexample.test%2Fchanged&sha256=deadbeef&fetchedAt=now";
  (document.source as { id: string; url: string }).id = "deadbeef";
  (document.source as { url: string }).url = "https://example.test/changed";
  (document.current as { sourceId: string; snapshotRef: string }).sourceId = "deadbeef";
  (document.current as { snapshotRef: string }).snapshotRef = bad;
  (document.check as { currentSnapshotRef: string }).currentSnapshotRef = bad;
  release(); const admitted = await pending;
  assert.equal(admitted.ok, true); if (!admitted.ok) return;
  assert.equal(admitted.value.current.sourceId, "source-a");
  assert.equal(admitted.value.current.url, "https://example.test/start");
  assert.equal(admitted.value.current.snapshotRef, reference);
});

test("public admission retains the prior source, URL, ref, and anchor captured before deferred resolution", async () => {
  const makeSnapshot = (body: string, fetchedAt: string): Snapshot => ({ sourceId: "source-a", url: "https://example.test/start", status: 200, fetchedAt, body, bodyHash: createHash("sha256").update(body).digest("hex") });
  const currentSnapshot = makeSnapshot("current-capture", "2026-08-26T00:00:00.000Z"); const priorSnapshot = makeSnapshot("prior-capture", "2026-08-25T00:00:00.000Z");
  const currentRef = buildSnapshotSourceRef(currentSnapshot); const priorRef = buildSnapshotSourceRef(priorSnapshot); let calls = 0; let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const snapshots: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact(reference) { calls++; if (calls === 2) await waiting; return { kind: "found", snapshot: reference.bodyHash === priorSnapshot.bodyHash ? priorSnapshot : currentSnapshot }; } };
  const document = { ...input(currentRef), prior: { sourceId: "source-a", snapshotRef: priorRef, check: { currentSnapshotRef: priorRef } } as never, snapshotStore: snapshots };
  const pending = admitProposalObservation(document);
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  const bad = "forage-snapshot:deadbeef?url=https%3A%2F%2Fexample.test%2Fchanged&sha256=deadbeef&fetchedAt=now";
  (document.source as { id: string; url: string }).id = "deadbeef";
  (document.source as { url: string }).url = "https://example.test/changed";
  (document.current as { sourceId: string; snapshotRef: string }).sourceId = "deadbeef";
  (document.current as { snapshotRef: string }).snapshotRef = bad;
  (document.check as { currentSnapshotRef: string }).currentSnapshotRef = bad;
  (document.prior as { sourceId: string; snapshotRef: string; check: { currentSnapshotRef: string } }).sourceId = "deadbeef";
  (document.prior as { snapshotRef: string }).snapshotRef = bad;
  (document.prior as { check: { currentSnapshotRef: string } }).check.currentSnapshotRef = bad;
  release(); const admitted = await pending;
  assert.equal(admitted.ok, true); if (!admitted.ok) return;
  assert.equal(admitted.value.current.sourceId, "source-a");
  assert.equal(admitted.value.current.url, "https://example.test/start");
  assert.equal(admitted.value.current.snapshotRef, currentRef);
  assert.equal(admitted.value.prior?.sourceId, "source-a");
  assert.equal(admitted.value.prior?.url, "https://example.test/start");
  assert.equal(admitted.value.prior?.snapshotRef, priorRef);
});

test("admission contains undefined and malformed prior state without capability I/O", async () => {
  let reads = 0; const snapshots: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact() { reads++; return { kind: "missing" }; } };
  const undefinedResult = await admitProposalObservation(undefined as never); assert.equal(undefinedResult.ok, false);
  const malformed = await admitProposalObservation({ ...input("forage-snapshot:source-a?url=https%3A%2F%2Fexample.test%2Fstart&sha256=deadbeef&fetchedAt=now"), prior: { sourceId: "source-a", snapshotRef: "x", check: undefined } as never, snapshotStore: snapshots });
  assert.equal(malformed.ok, false); assert.equal(reads, 0);
});

test("legacy redirect references fail closed while a direct legacy capture remains explicitly lower assurance", async () => {
  const body = "body";
  const direct: Snapshot = { sourceId: "source-a", url: "https://example.test/start", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex") };
  const redirected: Snapshot = { ...direct, fetchedAt: "2026-08-26T00:00:01.000Z", redirects: ["https://example.test/start"] };
  const values = [direct, redirected];
  const store: ExactSnapshotStore = { async put() {}, async latest() { return undefined; }, async get() { return undefined; }, async list() { return []; }, async findExact(reference) { const found = values.find((item) => item.sourceId === reference.sourceId && item.url === reference.url && item.bodyHash === reference.bodyHash && item.fetchedAt === reference.fetchedAt); return found ? { kind: "found", snapshot: found } : { kind: "missing" }; } };
  const legacy = (snapshot: Snapshot) => buildSnapshotSourceRef(snapshot).replace(/&snapshotSha256=[^&]+$/, "");
  assert.equal((await admitProposalObservation({ ...input(legacy(direct)), prior: null, snapshotStore: store })).ok, true);
  const rejected = await admitProposalObservation({ ...input(legacy(redirected)), prior: null, snapshotStore: store });
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.kind, "insufficient-binding");
});
