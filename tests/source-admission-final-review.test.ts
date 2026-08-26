import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInMemorySnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef, parseSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { admitProposalObservation, admitSourceCapture, admitSourceCheck, type CheckResult } from "../src/index.js";
import { source } from "./helpers.js";

const registered = source("source-a", { url: "https://example.test/start" });
const at = "2026-08-26T00:00:00.000Z";
function snapshot(body: string, fetchedAt: string): Snapshot {
  return { sourceId: registered.id, url: registered.url, status: 200, fetchedAt, body,
    bodyHash: createHash("sha256").update(body).digest("hex") };
}
async function fixture() {
  const original = snapshot("original", at);
  const replacement = snapshot("replacement", "2026-08-26T01:00:00.000Z");
  const store = createInMemorySnapshotStore();
  await store.put(original);
  await store.put(replacement);
  return { store, originalRef: buildSnapshotSourceRef(original), replacementRef: buildSnapshotSourceRef(replacement) };
}
async function substitutingFixture() {
  const f = await fixture();
  const findExact = f.store.findExact.bind(f.store);
  f.store.findExact = async (request) => {
    // An injected store may mutate its request. This must not mutate the
    // resolver's private expected identity or authenticate another capture.
    Object.assign(request, parseSnapshotSourceRef(f.replacementRef));
    return findExact(request);
  };
  return f;
}
function initial(snapshotRef: string): CheckResult {
  return { sourceId: registered.id, sourceUrl: registered.url, checkedAt: at, warnings: [],
    kind: "changed", changeBasis: "initial", priorSnapshotRef: null, currentSnapshotRef: snapshotRef };
}

test("public Forage resolver cannot authenticate a callback-substituted expected reference", async () => {
  const f = await substitutingFixture();
  const result = await resolveSnapshotSourceRef(f.store, f.originalRef);
  assert.equal(result.ok, false, "original ref must not resolve as the replacement capture");
});

test("source capture admission never splices original ref with callback-substituted metadata", async () => {
  const f = await substitutingFixture();
  const result = await admitSourceCapture({ source: registered, snapshotRef: f.originalRef, snapshotStore: f.store });
  assert.equal(result.ok, false);
});

test("source initial check admission rejects a callback-substituted current capture", async () => {
  const f = await substitutingFixture();
  const result = await admitSourceCheck({ source: registered, check: initial(f.originalRef), expectedPriorSnapshotRef: null, snapshotStore: f.store });
  assert.equal(result.ok, false);
});

test("source304 admission rejects callback substitution even when both declared refs are identical", async () => {
  const f = await substitutingFixture();
  const check: CheckResult = { sourceId: registered.id, sourceUrl: registered.url, checkedAt: at, warnings: [], kind: "unchanged-304", snapshotRef: f.originalRef };
  const result = await admitSourceCheck({ source: registered, check, expectedPriorSnapshotRef: f.originalRef, snapshotStore: f.store });
  assert.equal(result.ok, false);
});

test("existing proposal admission rejects callback substitution of its exact current identity", async () => {
  const f = await substitutingFixture();
  const result = await admitProposalObservation({ source: registered,
    current: { sourceId: registered.id, snapshotRef: f.originalRef, observedAt: at, proposals: [] },
    check: { checkedAt: at, resultKind: "changed", currentSnapshotRef: f.originalRef },
    prior: null, snapshotStore: f.store });
  assert.equal(result.ok, false);
});

for (const [name, mutate] of [
  ["array masquerading as result object", (value: CheckResult) => Object.assign([], value)],
  ["sparse warnings", (value: CheckResult) => ({ ...value, warnings: new Array(3) })],
  ["warnings shadowing array validation method", (value: CheckResult) => ({ ...value, warnings: Object.assign([], { some: null }) })],
] as const) test(`closed check shape rejects ${name} with a typed failure before I/O`, async () => {
  const f = await fixture();
  let reads = 0;
  const findExact = f.store.findExact.bind(f.store);
  f.store.findExact = async (request) => { reads++; return findExact(request); };
  const result = await admitSourceCheck({ source: registered, check: mutate(initial(f.originalRef)) as CheckResult, expectedPriorSnapshotRef: null, snapshotStore: f.store });
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
});

test("invalid calendar days and inherited-only result identities fail before I/O", async () => {
  const f = await fixture();
  let reads = 0;
  const findExact = f.store.findExact.bind(f.store);
  f.store.findExact = async (request) => { reads++; return findExact(request); };
  for (const check of [
    { ...initial(f.originalRef), checkedAt: "2026-02-30T00:00:00.000Z" },
    { ...initial(f.originalRef), checkedAt: "2026-08-26T24:00:00.000Z" },
    Object.create(initial(f.originalRef)) as CheckResult,
  ]) {
    const result = await admitSourceCheck({ source: registered, check, expectedPriorSnapshotRef: null, snapshotStore: f.store });
    assert.equal(result.ok, false);
  }
  assert.equal(reads, 0);
});
