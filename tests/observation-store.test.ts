import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createObservationStore, type ProposalObservationRecordInput } from "../src/index.js";

const input = (snapshotRef: string, recordedAt = `${snapshotRef}-recorded`): ProposalObservationRecordInput => ({
  observation: { sourceId: "source-a", snapshotRef, observedAt: `${snapshotRef}-observed`, proposals: [] },
  recordedAt,
  check: { checkedAt: `${snapshotRef}-checked`, resultKind: "changed", currentSnapshotRef: snapshotRef },
});

test("L3-AC4 store distinguishes a missing prior from a corrupt prior", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const store = createObservationStore({ root });
    assert.deepEqual(await store.loadLatest("source-a"), { ok: true, value: null });
    const committed = await store.commit(input("snapshot-1"), null);
    assert.equal(committed.ok, true);
    const latest = await store.loadLatest("source-a");
    assert.equal(latest.ok, true);
    if (!latest.ok || latest.value === null) return;
    const recordPath = path.join(root, latest.value.sourceKey, `${latest.value.observationId}.json`);
    const pointerPath = path.join(root, latest.value.sourceKey, "latest.json");
    const pointerBefore = await readFile(pointerPath);
    await writeFile(recordPath, "{}", "utf8");
    const corrupt = await store.loadLatest("source-a");
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.error.kind, "corrupt-state");
    const attempted = await store.commit(input("snapshot-2"), latest.value.observationId);
    assert.equal(attempted.ok, false);
    assert.deepEqual(await readFile(pointerPath), pointerBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("L3-AC5 retains latest two and a stale CAS never advances latest.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const store = createObservationStore({ root });
    const one = await store.commit(input("snapshot-1"), null);
    assert.equal(one.ok, true); if (!one.ok) return;
    const two = await store.commit(input("snapshot-2"), one.value.observationId);
    assert.equal(two.ok, true); if (!two.ok) return;
    const sourceDir = path.join(root, two.value.sourceKey);
    const before = await readFile(path.join(sourceDir, "latest.json"));
    const stale = await store.commit(input("snapshot-stale"), one.value.observationId);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.kind, "continuity-conflict");
    assert.deepEqual(await readFile(path.join(sourceDir, "latest.json")), before);
    const three = await store.commit(input("snapshot-3"), two.value.observationId);
    assert.equal(three.ok, true);
    const records = (await readdir(sourceDir)).filter((name) => name.endsWith(".json") && name !== "latest.json");
    assert.equal(records.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("L3-AC5 injected pointer failure restores byte-identical prior state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const base = createObservationStore({ root });
    const one = await base.commit(input("snapshot-1"), null);
    assert.equal(one.ok, true); if (!one.ok) return;
    const latestPath = path.join(root, one.value.sourceKey, "latest.json");
    const before = await readFile(latestPath);
    const failing = createObservationStore({ root, faults: { beforePointerRename: () => { throw new Error("injected pointer rename"); } } });
    const result = await failing.commit(input("snapshot-2"), one.value.observationId);
    assert.equal(result.ok, false);
    assert.deepEqual(await readFile(latestPath), before);
    const loaded = await base.loadLatest("source-a");
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.value?.observationId, one.value.observationId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review remediation: same-digest retry failure never deletes the immutable latest record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const base = createObservationStore({ root }); const value = input("snapshot-1");
    const one = await base.commit(value, null); assert.equal(one.ok, true); if (!one.ok) return;
    const dir = path.join(root, one.value.sourceKey); const recordPath = path.join(dir, `${one.value.observationId}.json`); const pointerPath = path.join(dir, "latest.json");
    const recordBefore = await readFile(recordPath); const pointerBefore = await readFile(pointerPath);
    const failed = await createObservationStore({ root, faults: { beforePointerRename: () => { throw new Error("retry pointer failure"); } } }).commit(value, one.value.observationId);
    assert.equal(failed.ok, false); assert.deepEqual(await readFile(recordPath), recordBefore); assert.deepEqual(await readFile(pointerPath), pointerBefore);
    assert.equal((await base.loadLatest("source-a")).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review remediation: retention preserves current and genuine predecessor with a backward clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const store = createObservationStore({ root });
    const one = await store.commit(input("snapshot-1", "2026-07-10T12:00:03Z"), null); assert.equal(one.ok, true); if (!one.ok) return;
    const two = await store.commit(input("snapshot-2", "2026-07-10T12:00:02Z"), one.value.observationId); assert.equal(two.ok, true); if (!two.ok) return;
    const three = await store.commit(input("snapshot-3", "2026-07-10T12:00:01Z"), two.value.observationId); assert.equal(three.ok, true); if (!three.ok) return;
    const names = await readdir(path.join(root, three.value.sourceKey));
    assert.equal(names.includes(`${three.value.observationId}.json`), true); assert.equal(names.includes(`${two.value.observationId}.json`), true); assert.equal(names.includes(`${one.value.observationId}.json`), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review remediation: malformed current schema and hostile source ids return typed errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const store = createObservationStore({ root });
    const malformed = await store.commit({ ...input("snapshot"), observation: { ...input("snapshot").observation, proposals: [{} as never] } }, null);
    assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.error.kind, "invalid-input");
    const hostile = await store.loadLatest("\ud800"); assert.equal(hostile.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review remediation: pointer ids are strict digests and symlinked state is never followed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-")); const outside = await mkdtemp(path.join(os.tmpdir(), "lookout-outside-"));
  try {
    const base = createObservationStore({ root }); const one = await base.commit(input("snapshot-1"), null); assert.equal(one.ok, true); if (!one.ok) return;
    const dir = path.join(root, one.value.sourceKey); const pointerPath = path.join(dir, "latest.json");
    await writeFile(pointerPath, JSON.stringify({ version: 1, sourceId: "source-a", observationId: "../outside" }));
    const traversal = await base.loadLatest("source-a"); assert.equal(traversal.ok, false); if (!traversal.ok) assert.equal(traversal.error.kind, "corrupt-state");
    await rm(root, { recursive: true, force: true }); await mkdir(root); await symlink(outside, path.join(root, one.value.sourceKey));
    const marker = path.join(outside, "marker"); await writeFile(marker, "unchanged");
    const refused = await base.commit(input("snapshot-2"), one.value.observationId); assert.equal(refused.ok, false); assert.equal(await readFile(marker, "utf8"), "unchanged"); assert.deepEqual(await readdir(outside), ["marker"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

for (const [label, faults] of [
  ["serialization", { beforeSerialize: () => { throw new Error("serialization"); } }],
  ["temp write", { beforeTempWrite: () => { throw new Error("temp write"); } }],
  ["file fsync", { beforeFileSync: () => { throw new Error("file fsync"); } }],
  ["record rename", { beforeRecordRename: () => { throw new Error("record rename"); } }],
  ["pointer rename", { beforePointerRename: () => { throw new Error("pointer rename"); } }],
] as const) {
  test(`review remediation: ${label} failure leaves full prior state byte-identical`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
    try {
      const base = createObservationStore({ root }); const one = await base.commit(input("snapshot-1"), null); assert.equal(one.ok, true); if (!one.ok) return;
      const dir = path.join(root, one.value.sourceKey); const beforeNames = await readdir(dir); const before = new Map(await Promise.all(beforeNames.map(async (name) => [name, await readFile(path.join(dir, name))] as const)));
      const result = await createObservationStore({ root, faults }).commit(input("snapshot-2"), one.value.observationId); assert.equal(result.ok, false);
      const afterNames = await readdir(dir); assert.deepEqual(afterNames, beforeNames); for (const name of afterNames) assert.deepEqual(await readFile(path.join(dir, name)), before.get(name));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("review remediation: prune failure is a committed warning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const one = await createObservationStore({ root }).commit(input("snapshot-1"), null); assert.equal(one.ok, true); if (!one.ok) return;
    const two = await createObservationStore({ root, faults: { beforePrune: () => { throw new Error("prune"); } } }).commit(input("snapshot-2"), one.value.observationId);
    assert.equal(two.ok, true); if (two.ok) assert.match(two.warnings?.[0] ?? "", /prune/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("second review: record directory-fsync failure restores the complete precommit state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const base = createObservationStore({ root }); const one = await base.commit(input("snapshot-1"), null); assert.equal(one.ok, true); if (!one.ok) return;
    const dir = path.join(root, one.value.sourceKey); const names = await readdir(dir); const before = new Map(await Promise.all(names.map(async (name) => [name, await readFile(path.join(dir, name))] as const)));
    const failed = await createObservationStore({ root, faults: { beforeDirectorySync(kind) { if (kind === "record") throw new Error("record directory fsync"); } } }).commit(input("snapshot-2"), one.value.observationId);
    assert.equal(failed.ok, false); assert.deepEqual(await readdir(dir), names); for (const name of names) assert.deepEqual(await readFile(path.join(dir, name)), before.get(name));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("second review: pointer directory-fsync failure keeps a readable valid commit and reports durability warning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-observations-"));
  try {
    const base = createObservationStore({ root }); const one = await base.commit(input("snapshot-1"), null); assert.equal(one.ok, true); if (!one.ok) return;
    const result = await createObservationStore({ root, faults: { beforeDirectorySync(kind) { if (kind === "pointer") throw new Error("pointer directory fsync"); } } }).commit(input("snapshot-2"), one.value.observationId);
    assert.equal(result.ok, true); if (!result.ok) return; assert.match(result.warnings?.[0] ?? "", /pointer rename completed but directory fsync failed/);
    const latest = await base.loadLatest("source-a"); assert.equal(latest.ok, true); if (latest.ok) assert.equal(latest.value?.observationId, result.value.observationId);
    const files = await readdir(path.join(root, result.value.sourceKey)); assert.equal(files.includes(`${result.value.observationId}.json`), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
