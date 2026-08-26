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
    const require = createRequire(import.meta.url); const Ajv2020 = require("ajv/dist/2020.js") as new (options: { strict: boolean }) => { addSchema(schema: object): void; getSchema(id: string): ((value: unknown) => boolean) | undefined };
    const { schemas } = await import("hachure") as { schemas: Map<string, object> };
    const ajv = new Ajv2020({ strict: false }); for (const schema of schemas.values()) ajv.addSchema(schema);
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
