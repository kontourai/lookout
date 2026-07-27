import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import type { CheckResult } from "../src/check-result.js";
import { loadRegistry, RegistryValidationError, type LookoutSource } from "../src/registry.js";
import { inMemorySourceStore, type SourceStore } from "../src/source-store.js";
import { source } from "./helpers.js";

// One contract, two implementations. Every behavior asserted here must hold
// for the file-backed registry and the in-memory store alike, so both run
// the same suite through their own constructor.
interface SourceStoreImplementation {
  name: string;
  make(sources: LookoutSource[]): Promise<SourceStore>;
}

async function fileBackedStore(sources: LookoutSource[]): Promise<SourceStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-source-store-"));
  const registryPath = path.join(root, "sources.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, sources }));
  return loadRegistry(registryPath);
}

const implementations: SourceStoreImplementation[] = [
  { name: "file-backed registry", make: fileBackedStore },
  { name: "in-memory store", make: async (sources) => inMemorySourceStore(sources) },
];

for (const implementation of implementations) {
  test(`${implementation.name}: list() returns every source in construction order`, async () => {
    const store = await implementation.make([source("beta"), source("alpha"), source("gamma")]);
    const listed = await store.list();
    assert.deepEqual(listed.map((item) => item.id), ["beta", "alpha", "gamma"]);
  });

  test(`${implementation.name}: get() resolves exact ids and returns undefined for unknown ids`, async () => {
    const store = await implementation.make([source("alpha"), source("beta")]);
    assert.equal((await store.get("beta"))?.id, "beta");
    assert.equal((await store.get("beta"))?.url, "https://example.test/beta");
    assert.equal(await store.get("missing"), undefined);
    assert.equal(await store.get("ALPHA"), undefined);
  });

  test(`${implementation.name}: rejects duplicate ids with RegistryValidationError`, async () => {
    await assert.rejects(
      implementation.make([source("same"), source("same")]),
      (error: unknown) => {
        assert.ok(error instanceof RegistryValidationError);
        assert.match(error.message, /duplicates sources\[0\]/);
        return true;
      },
    );
  });

  test(`${implementation.name}: rejects invalid source fields with every issue reported`, async () => {
    await assert.rejects(
      implementation.make([
        source("bad-url", { url: "not-a-url" }),
        source("bad-policy", { renderPolicy: "sometimes" as never }),
      ]),
      (error: unknown) => {
        assert.ok(error instanceof RegistryValidationError);
        assert.match(error.message, /absolute HTTP\(S\) URL/);
        assert.match(error.message, /renderPolicy/);
        return true;
      },
    );
  });

  test(`${implementation.name}: an empty store lists nothing and resolves nothing`, async () => {
    const store = await implementation.make([]);
    assert.deepEqual([...await store.list()], []);
    assert.equal(await store.get("anything"), undefined);
  });
}

test("a promise-returning SourceStore drives the CLI end to end", async () => {
  // The contract allows async list/get so a database-backed store can query
  // lazily; prove the CLI works against an implementation that is only async.
  const sources = [source("first"), source("second")];
  const asyncStore: SourceStore = {
    list: async () => sources,
    get: async (id) => sources.find((item) => item.id === id),
  };
  const output = capture();
  const exitCode = await runCli({
    argv: ["check", "--all"],
    stdout: output,
    stderr: capture(),
    loadRegistry: async () => asyncStore,
    runner: {
      check: async (checked) => result(checked.id),
      checkAll: async (checked) => checked.map((item) => result(item.id)),
    },
  });
  assert.equal(exitCode, 0);
  const lines = output.value.trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).sourceId), ["first", "second"]);
});

function result(sourceId: string): CheckResult {
  return {
    sourceId,
    sourceUrl: `https://example.test/${sourceId}`,
    checkedAt: "2026-07-27T00:00:00.000Z",
    warnings: [],
    kind: "unchanged-hash",
    priorSnapshotRef: "prior-ref",
    currentSnapshotRef: "current-ref",
  };
}

function capture(): { value: string; write(chunk: string): boolean } {
  return {
    value: "",
    write(chunk: string) {
      this.value += chunk;
      return true;
    },
  };
}
