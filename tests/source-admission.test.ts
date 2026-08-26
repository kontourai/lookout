import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createInMemorySnapshotStore, type ExactSnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef, fetchSource } from "@kontourai/forage/fetch";
import { admitSourceCapture, admitSourceCheck, createCheckRunner } from "../src/index.js";
import { source } from "./helpers.js";

const registered = source("source-a", { url: "https://example.test/start" });
const at = "2026-08-26T00:00:00.000Z";
function snapshot(body: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return { sourceId: registered.id, url: registered.url, status: 200, fetchedAt: at, body,
    bodyHash: createHash("sha256").update(body).digest("hex"), ...overrides };
}
async function fixture(values = [snapshot("old"), snapshot("new", { fetchedAt: "2026-08-26T01:00:00.000Z" })]) {
  const store = createInMemorySnapshotStore();
  for (const value of values) await store.put(value);
  return { store, prior: buildSnapshotSourceRef(values[0]!), current: buildSnapshotSourceRef(values.at(-1)!) };
}
function changed(prior: string | null, current: string) {
  return { sourceId: registered.id, sourceUrl: registered.url, checkedAt: at, warnings: [],
    kind: "changed" as const, priorSnapshotRef: prior, currentSnapshotRef: current, changeBasis: prior === null ? "initial" as const : "hash" as const };
}

test("source admission composes real Forage 200/same-hash/conditional304/same-hash/changed checks without writes or fabricated metadata", async () => {
  const store = createInMemorySnapshotStore(); let tick = 0, mode = "same", network = 0, writes = 0;
  const put = store.put.bind(store); store.put = async value => { writes++; await put(value); };
  const runner = createCheckRunner({ store, clock: () => `2026-08-26T02:00:0${tick}.000Z`,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0 }, {
      ...options, clock: () => `2026-08-26T01:00:0${++tick}.000Z`,
      fetch: async (_url, init) => { network++; if (mode === "304") {
        assert.equal(new Headers(init?.headers).get("if-none-match"), '"v1"');
        return new Response(null, { status: 304 });
      } return new Response(mode === "changed" ? "changed" : "same", { status: 200, headers: { etag: '"v1"' } }); },
    }) });
  let baseline: string | null = null;
  for (const [nextMode, expected] of [["same", "changed"], ["same", "unchanged-hash"], ["304", "unchanged-304"], ["same", "unchanged-hash"], ["changed", "changed"]] as const) {
    mode = nextMode; const check = await runner.check(registered); assert.equal(check.kind, expected);
    const before = { network, writes };
    const result = await admitSourceCheck({ source: registered, check, expectedPriorSnapshotRef: baseline, snapshotStore: store });
    assert.equal(result.ok, true); if (!result.ok) continue;
    assert.equal(result.value.checkedAt, check.checkedAt);
    assert.notEqual(result.value.current.fetchedAt, check.checkedAt);
    assert.equal(result.value.current.bodyHash, createHash("sha256").update(nextMode === "changed" ? "changed" : "same").digest("hex"));
    if (nextMode === "304") assert.deepEqual(result.value.current, result.value.prior);
    baseline = result.value.current.snapshotRef;
    const capture = await admitSourceCapture({ source: registered, snapshotRef: baseline, snapshotStore: store });
    assert.equal(capture.ok, true); assert.deepEqual({ network, writes }, before);
    assert.equal(JSON.stringify(result).includes('"body":'), false);
  }
});

for (const [name, mutation] of [
  ["unknown kind", { kind: "future" }], ["unknown basis", { changeBasis: "future" }],
  ["invalid timestamp", { checkedAt: "not-a-date" }], ["invalid warnings", { warnings: 42 }],
  ["extra variant property", { snapshotRef: "unexpected" }],
  ["wrong source", { sourceId: "other" }], ["wrong registered URL", { sourceUrl: "https://other.test/" }],
] as const) test(`invalid ${name} is rejected before capability I/O`, async () => {
  const f = await fixture(); let reads = 0;
  const find = f.store.findExact.bind(f.store); f.store.findExact = async ref => { reads++; return find(ref); };
  const result = await admitSourceCheck({ source: registered, check: { ...changed(f.prior, f.current), ...mutation } as never, expectedPriorSnapshotRef: f.prior, snapshotStore: f.store });
  assert.equal(result.ok, false); assert.equal(reads, 0);
});

test("all malformed refs are rejected before even the valid current ref performs I/O", async () => {
  const f = await fixture(); let reads = 0; const find = f.store.findExact.bind(f.store);
  f.store.findExact = async ref => { reads++; return find(ref); };
  assert.equal((await admitSourceCheck({ source: registered, check: changed("bad-ref", f.current), expectedPriorSnapshotRef: "bad-ref", snapshotStore: f.store })).ok, false);
  assert.equal(reads, 0);
});

test("initial cannot smuggle a declared prior; unchanged-hash cannot have null prior", async () => {
  const f = await fixture();
  assert.equal((await admitSourceCheck({ source: registered, check: { ...changed(f.prior, f.current), changeBasis: "initial" }, expectedPriorSnapshotRef: null, snapshotStore: f.store })).ok, false);
  assert.equal((await admitSourceCheck({ source: registered, check: { ...changed(null, f.current), kind: "unchanged-hash" } as never, expectedPriorSnapshotRef: null, snapshotStore: f.store })).ok, false);
});

test("equal bodies at different final URLs are changed, not unchanged-hash", async () => {
  const f = await fixture([snapshot("same", { url: "https://example.test/old" }), snapshot("same", { fetchedAt: "2026-08-26T01:00:00.000Z" })]);
  const check = { sourceId: registered.id, sourceUrl: registered.url, checkedAt: at, warnings: [], kind: "unchanged-hash" as const, priorSnapshotRef: f.prior, currentSnapshotRef: f.current };
  assert.equal((await admitSourceCheck({ source: registered, check, expectedPriorSnapshotRef: f.prior, snapshotStore: f.store })).ok, false);
  assert.equal((await admitSourceCheck({ source: registered, check: changed(f.prior, f.current), expectedPriorSnapshotRef: f.prior, snapshotStore: f.store })).ok, true);
});

for (const [name, value] of [
  ["cross-host", snapshot("body", { url: "https://other.test/final", redirects: [registered.url] })],
  ["downgrade", snapshot("body", { url: "http://example.test/final", redirects: [registered.url] })],
] as const) test(`capture admission rejects authenticated but inadmissible ${name} redirects`, async () => {
  const f = await fixture([value]);
  assert.equal((await admitSourceCapture({ source: registered, snapshotRef: f.current, snapshotStore: f.store })).ok, false);
});

test("direct legacy stays lower assurance while current AND historical legacy redirects are refused", async () => {
  const direct = snapshot("old"), redirect = snapshot("old", { redirects: [registered.url], fetchedAt: "2026-08-26T00:01:00.000Z" });
  const fresh = snapshot("new", { fetchedAt: "2026-08-26T01:00:00.000Z" }); const f = await fixture([direct, redirect, fresh]);
  const legacy = (s: Snapshot) => buildSnapshotSourceRef(s).replace(/&snapshotSha256=[^&]+$/, "");
  const admitted = await admitSourceCapture({ source: registered, snapshotRef: legacy(direct), snapshotStore: f.store });
  assert.equal(admitted.ok, true); if (admitted.ok) { assert.equal(admitted.value.capture.integrity, "body-and-identity"); assert.equal(admitted.value.capture.snapshotDigest, undefined); }
  assert.equal((await admitSourceCapture({ source: registered, snapshotRef: legacy(redirect), snapshotStore: f.store })).ok, false);
  assert.equal((await admitSourceCheck({ source: registered, check: changed(legacy(redirect), f.current), expectedPriorSnapshotRef: legacy(redirect), snapshotStore: f.store })).ok, false);
});

test("invocation snapshots source, check, expected baseline, store reference AND exact-reader capability before await", async () => {
  const f = await fixture(); let begun!: () => void, release!: () => void; const entered = new Promise<void>(r => { begun = r; }); const paused = new Promise<void>(r => { release = r; });
  const find = f.store.findExact.bind(f.store); let reads = 0, substituted = 0;
  f.store.findExact = async ref => { if (++reads === 1) { begun(); await paused; } return find(ref); };
  const input = { source: structuredClone(registered), check: changed(f.prior, f.current), expectedPriorSnapshotRef: f.prior, snapshotStore: f.store };
  const pending = admitSourceCheck(input); await entered;
  input.source.id = "other"; input.check.currentSnapshotRef = "bad"; input.expectedPriorSnapshotRef = "bad";
  f.store.findExact = async () => { substituted++; return { kind: "missing" }; };
  input.snapshotStore = createInMemorySnapshotStore(); release();
  const result = await pending; assert.equal(result.ok, true); assert.equal(substituted, 0);
  if (result.ok) { assert.equal(result.value.current.snapshotRef, f.current); assert.equal(result.value.prior?.snapshotRef, f.prior); }
});

test("malformed caller input returns typed failure, not a rejected promise or raw diagnostics", async () => {
  const f = await fixture();
  for (const sourceValue of [null, undefined, 42]) {
    const result = await admitSourceCheck({ source: sourceValue as never, check: changed(f.prior, f.current), expectedPriorSnapshotRef: f.prior, snapshotStore: f.store });
    assert.equal(result.ok, false);
  }
});

test("wrong304 baseline and operational error never admit a successful current capture", async () => {
  const f = await fixture(); const common = { sourceId: registered.id, sourceUrl: registered.url, checkedAt: at, warnings: [] };
  for (const check of [{ ...common, kind: "unchanged-304" as const, snapshotRef: f.current }, { ...common, kind: "error" as const, origin: "forage" as const, error: { kind: "network" as const, message: "/private/diagnostic" } }]) {
    const result = await admitSourceCheck({ source: registered, check, expectedPriorSnapshotRef: f.prior, snapshotStore: f.store });
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("/private/diagnostic"), false);
  }
});
