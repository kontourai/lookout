import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ExactSnapshotStore } from "@kontourai/forage";
import {
  createLookoutSnapshotStore,
  resolveLookoutSnapshot,
} from "../src/snapshot-store.js";
import { snapshot } from "./helpers.js";

test("snapshot-store wrapper persists under an injected temporary root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-snapshots-"));
  try {
    const store = createLookoutSnapshotStore(root);
    const value = snapshot("alpha", "persisted");
    await store.put(value);
    assert.deepEqual(await store.latest("alpha"), value);
    assert.equal((await store.get("alpha", value.bodyHash))?.body, "persisted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact snapshot replay uses the configured Lookout root without fetching", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-replay-"));
  const body = "benchmark body";
  const value = {
    sourceId: "source-a",
    url: "https://example.test/benchmark.json",
    status: 200,
    fetchedAt: "2026-07-18T12:00:00.000Z",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
  try {
    await createLookoutSnapshotStore(root).put(value);
    const replay = await resolveLookoutSnapshot(buildSnapshotSourceRef(value), { root });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.snapshot.body, body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact snapshot replay supports injected stores and the default Lookout root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-replay-selection-"));
  const originalCwd = process.cwd();
  const value = snapshot("selection", "selected");
  const reference = buildSnapshotSourceRef(value);
  try {
    const injectedStore = createLookoutSnapshotStore(path.join(root, "injected"));
    await injectedStore.put(value);
    const injected = await resolveLookoutSnapshot(reference, { store: injectedStore });
    assert.equal(injected.ok, true);

    process.chdir(root);
    await createLookoutSnapshotStore().put(value);
    const defaulted = await resolveLookoutSnapshot(reference);
    assert.equal(defaulted.ok, true);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("exact snapshot replay preserves Forage failure classifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-replay-missing-"));
  try {
    const malformed = await resolveLookoutSnapshot("not-a-snapshot-reference", { root });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.kind, "invalid-reference");

    const body = "missing";
    const missing = await resolveLookoutSnapshot(buildSnapshotSourceRef({
      sourceId: "source-a",
      url: "https://example.test/missing.json",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    }), { root });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.kind, "snapshot-not-found");

    const baseStore = createLookoutSnapshotStore(root) as ExactSnapshotStore;
    const mismatchStore: ExactSnapshotStore = {
      put: baseStore.put.bind(baseStore),
      latest: baseStore.latest.bind(baseStore),
      get: baseStore.get.bind(baseStore),
      list: baseStore.list.bind(baseStore),
      findExact: async () => ({ kind: "mismatch" }),
    };
    const mismatch = await resolveLookoutSnapshot(buildSnapshotSourceRef({
      sourceId: "source-a",
      url: "https://example.test/mismatch.json",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    }), { store: mismatchStore });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.kind, "snapshot-mismatch");

    const failingStore: ExactSnapshotStore = {
      ...mismatchStore,
      findExact: async () => { throw new Error("backend unavailable"); },
    };
    const storeError = await resolveLookoutSnapshot(buildSnapshotSourceRef({
      sourceId: "source-a",
      url: "https://example.test/store-error.json",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    }), { store: failingStore });
    assert.equal(storeError.ok, false);
    if (!storeError.ok) assert.equal(storeError.error.kind, "snapshot-store-error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact snapshot replay contains failures while selecting the snapshot store", async () => {
  const value = snapshot("selection-error", "body");
  const options = {} as { store: ExactSnapshotStore };
  Object.defineProperty(options, "store", {
    get() { throw new Error("store accessor must not escape"); },
  });

  const pending = resolveLookoutSnapshot(buildSnapshotSourceRef(value), options);
  assert.ok(pending instanceof Promise);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "snapshot-store-error");
});
