import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRegistry, parseRegistry, RegistryValidationError } from "../src/registry.js";

test("registry loads a version-1 file and preserves source order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lookout-registry-"));
  const registryPath = path.join(root, "sources.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, sources: [validSource("beta"), validSource("alpha")] }));
  const registry = await loadRegistry(registryPath);
  assert.deepEqual(registry.list().map((source) => source.id), ["beta", "alpha"]);
  assert.equal(registry.get("alpha")?.id, "alpha");
});

test("registry rejects duplicate ids and reports every invalid field", () => {
  assert.throws(
    () => parseRegistry({
      version: 2,
      sources: [
        validSource("same"),
        {
          id: "same",
          kind: "feed",
          url: "relative",
          cadenceHint: "",
          renderPolicy: "sometimes",
          targetSchema: [{ path: "", type: "mystery", enumValues: [1], required: "yes", inferenceType: "guess" }],
        },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof RegistryValidationError);
      assert.ok(error.issues.length >= 9);
      assert.match(error.message, /version must be exactly 1/);
      assert.match(error.message, /duplicates sources\[0\]/);
      assert.match(error.message, /targetSchema\[0\]\.inferenceType/);
      return true;
    },
  );
});

test("registry rejects non-http URLs without reading the network", () => {
  let networkReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { networkReads += 1; throw new Error("network forbidden"); }) as typeof fetch;
  try {
    assert.throws(() => parseRegistry({ version: 1, sources: [validSource("bad", { url: "file:///tmp/body" })] }), /absolute HTTP\(S\)/);
    assert.equal(networkReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registry accepts structured files with an explicit supported format", () => {
  const registry = parseRegistry({
    version: 1,
    sources: [{
      id: "benchmark-snapshot",
      kind: "structured-file",
      format: "yaml",
      url: "https://raw.githubusercontent.com/example/project/0123456789abcdef0123456789abcdef01234567/results.yml",
      cadenceHint: "weekly",
    }],
  });
  assert.deepEqual(registry.get("benchmark-snapshot"), {
    id: "benchmark-snapshot",
    kind: "structured-file",
    format: "yaml",
    url: "https://raw.githubusercontent.com/example/project/0123456789abcdef0123456789abcdef01234567/results.yml",
    cadenceHint: "weekly",
  });
});

test("registry rejects unsupported or cross-kind structured-file fields", () => {
  assert.throws(
    () => parseRegistry({
      version: 1,
      sources: [{
        id: "bad-structured-file",
        kind: "structured-file",
        format: "toml",
        url: "https://example.test/results.toml",
        cadenceHint: "daily",
        targetSchema: [],
        renderPolicy: "never",
      }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof RegistryValidationError);
      assert.match(error.message, /format must be "yaml", "json", or "csv"/);
      assert.match(error.message, /targetSchema is not allowed/);
      assert.match(error.message, /renderPolicy is not allowed/);
      return true;
    },
  );
  assert.throws(
    () => parseRegistry({ version: 1, sources: [validSource("wrong-kind-field", { format: "json" })] }),
    /format is only allowed for structured-file/,
  );
  assert.throws(
    () => parseRegistry({
      version: 1,
      sources: [validSource("invalid-kind-format", { kind: "feed", format: "json" })],
    }),
    (error: unknown) => {
      assert.ok(error instanceof RegistryValidationError);
      assert.match(error.message, /kind must be/);
      assert.match(error.message, /format is only allowed for structured-file/);
      return true;
    },
  );
});

function validSource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "web-page",
    url: `https://example.test/${id}`,
    targetSchema: [{ path: "title", type: "string" }],
    cadenceHint: "daily",
    renderPolicy: "never",
    ...overrides,
  };
}
