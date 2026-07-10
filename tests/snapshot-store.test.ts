import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLookoutSnapshotStore } from "../src/snapshot-store.js";
import { snapshot } from "./helpers.js";

test("snapshot-store wrapper persists under an injected temporary root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-snapshots-"));
  const store = createLookoutSnapshotStore(root);
  const value = snapshot("alpha", "persisted");
  await store.put(value);
  assert.deepEqual(await store.latest("alpha"), value);
  assert.equal((await store.get("alpha", value.bodyHash))?.body, "persisted");
});
