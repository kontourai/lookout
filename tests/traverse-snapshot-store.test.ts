// A host that passes a Traverse snapshot store: captures must be stored, read
// back as the snapshot written, and give `unchanged-hash` on a repeat of the
// same bytes. Real check runner, real Forage fetch, real Traverse stores.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInMemorySnapshotStore as createForageMemoryStore } from "@kontourai/forage";
import { buildSnapshotSourceRef, fetchSource, type SnapshotStore } from "@kontourai/forage/fetch";
import {
  createFilesystemSnapshotStore as createTraverseFilesystemStore,
  createInMemorySnapshotStore as createTraverseMemoryStore,
  type SnapshotStore as TraverseSnapshotStore,
} from "@kontourai/traverse/fetch";
import { createCheckRunner, fromTraverseSnapshotStore, resolveLookoutSnapshot, type CheckResult } from "../src/index.js";
import { source } from "./helpers.js";

// "café crème" in ISO-8859-1: not valid UTF-8, so the hash is over these bytes.
const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0x00, 0xfe, 0x0a]);

const PAGES = [
  { name: "latin1 text", contentType: "text/html; charset=iso-8859-1", bytes: LATIN1, body: "café crème" },
  { name: "binary pdf", contentType: "application/pdf", bytes: PDF, body: PDF },
] as const;

function tempRoot(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "lookout-traverse-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runnerFor(store: SnapshotStore, page: { contentType: string; bytes: Uint8Array }) {
  let tick = 0;
  return createCheckRunner({
    store,
    fetchSource: (config, options) => fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0 }, {
      ...options,
      clock: () => `2026-10-01T00:00:${String(++tick).padStart(2, "0")}.000Z`,
      fetch: async () => new Response(page.bytes.slice(), { status: 200, headers: { "content-type": page.contentType } }),
    }),
  });
}

function refOf(result: CheckResult): string {
  assert.ok(result.kind === "changed" || result.kind === "unchanged-hash", JSON.stringify(result));
  return result.currentSnapshotRef;
}

const traverseStores: Array<[string, (t: { after(fn: () => void): void }) => TraverseSnapshotStore]> = [
  ["filesystem", (t) => createTraverseFilesystemStore({ root: tempRoot(t) })],
  ["in-memory", () => createTraverseMemoryStore()],
];

for (const [storeName, makeTraverseStore] of traverseStores) {
  for (const page of PAGES) {
    test(`Traverse ${storeName} store: a ${page.name} capture is stored, reads back, and repeats as unchanged-hash`, async (t) => {
      const traverseStore = makeTraverseStore(t);
      const store = fromTraverseSnapshotStore(traverseStore);
      const live = { contentType: page.contentType, bytes: page.bytes };
      const runner = runnerFor(store, live);

      const first = await runner.check(source());
      assert.equal(first.kind, "changed", JSON.stringify(first));
      assert.equal(first.kind === "changed" && first.changeBasis, "initial");
      // Stored in the Traverse store's own record shape.
      const records = await traverseStore.list("source-a");
      assert.equal(records.length, 1);
      assert.equal(records[0]!.contentType, page.body instanceof Uint8Array ? "pdf" : "html");

      // Reads back as the capture written: same body, and its reference resolves.
      const firstRef = refOf(first);
      const resolved = await resolveLookoutSnapshot(firstRef, { store });
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      if (!resolved.ok) return;
      assert.deepEqual(resolved.snapshot.body, page.body);
      assert.equal(resolved.integrity, "snapshot-envelope");

      const repeat = await runner.check(source());
      assert.equal(repeat.kind, "unchanged-hash", JSON.stringify(repeat));
      assert.equal(repeat.kind === "unchanged-hash" && repeat.priorSnapshotRef, firstRef);
      assert.equal((await traverseStore.list("source-a")).length, 1);

      live.bytes = new Uint8Array([...page.bytes, 0x21]);
      const changed = await runner.check(source());
      assert.equal(changed.kind, "changed", JSON.stringify(changed));
      assert.equal(changed.kind === "changed" && changed.priorSnapshotRef, firstRef);
      assert.equal((await traverseStore.list("source-a")).length, 2);
      assert.equal((await resolveLookoutSnapshot(refOf(changed), { store })).ok, true);
    });
  }
}

test("a Forage store is unchanged: the same checks store, read back, and repeat as unchanged-hash", async () => {
  for (const page of PAGES) {
    const store = createForageMemoryStore();
    const runner = runnerFor(store, page);
    const first = await runner.check(source());
    assert.equal(first.kind, "changed", JSON.stringify(first));
    const resolved = await resolveLookoutSnapshot(refOf(first), { store });
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.deepEqual(resolved.snapshot.body, page.body);
    assert.equal((await runner.check(source())).kind, "unchanged-hash");
    assert.equal((await store.list("source-a")).length, 1);
  }
});

test("a Traverse store passed directly fails closed: nothing is stored and a Traverse prior is refused", async () => {
  const traverseStore = createTraverseMemoryStore();
  const page = PAGES[0];
  // Lookout's store type is Forage's; a Traverse store satisfies it only structurally.
  const runner = runnerFor(traverseStore as unknown as SnapshotStore, page);

  const first = await runner.check(source());
  assert.equal(first.kind, "error");
  assert.equal(first.kind === "error" && first.error.kind, "persistence");
  assert.equal((await traverseStore.list("source-a")).length, 0);

  // A readable Traverse record of the same bytes, stored through the adapter.
  await fromTraverseSnapshotStore(traverseStore).put((await (async () => {
    const forage = createForageMemoryStore();
    await runnerFor(forage, page).check(source());
    return (await forage.latest("source-a"))!;
  })()));
  const withPrior = await runner.check(source());
  assert.equal(withPrior.kind, "error", JSON.stringify(withPrior));
  assert.equal(withPrior.kind === "error" && withPrior.error.kind, "prior-read");
  assert.equal((await traverseStore.list("source-a")).length, 1);
});

test("exact lookup through the adapter chooses the record its reference names when two share an identity", async () => {
  const forage = createForageMemoryStore();
  await runnerFor(forage, PAGES[0]).check(source());
  const captured = (await forage.latest("source-a"))!;
  const store = fromTraverseSnapshotStore(createTraverseMemoryStore());
  const variant = { ...captured, headers: { ...captured.headers, etag: '"v2"' } };
  await store.put(captured);
  await store.put(variant);
  for (const written of [captured, variant]) {
    const resolved = await resolveLookoutSnapshot(buildSnapshotSourceRef(written), { store });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    if (resolved.ok) assert.deepEqual(resolved.snapshot.headers, written.headers);
  }
});
