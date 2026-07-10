import assert from "node:assert/strict";
import test from "node:test";
import type { CheckResult } from "../src/check-result.js";
import type { CheckRunner } from "../src/check-runner.js";
import { runCli } from "../src/cli.js";
import { LookoutRegistry } from "../src/registry.js";
import { source } from "./helpers.js";

test("AC1 CLI --all emits exactly one JSON line per source in registry order", async () => {
  const registry = new LookoutRegistry([source("first"), source("second")]);
  const output = capture();
  const exitCode = await runCli({
    argv: ["check", "--all"], stdout: output, stderr: capture(),
    loadRegistry: async () => registry,
    runner: runnerFor([result("first", "changed"), result("second", "unchanged-hash")]),
  });
  assert.equal(exitCode, 0);
  const lines = output.value.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line).sourceId), ["first", "second"]);
});

test("AC4 CLI serializes traverse FetchError and exits zero for a per-source failure", async () => {
  const registry = new LookoutRegistry([source("broken")]);
  const output = capture();
  const errorResult: CheckResult = {
    ...common("broken"), kind: "error", origin: "traverse",
    error: { kind: "http-error", message: "unavailable", status: 503 },
  };
  const exitCode = await runCli({
    argv: ["check", "broken"], stdout: output, stderr: capture(),
    loadRegistry: async () => registry, runner: runnerFor([errorResult]),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.value).error, { kind: "http-error", message: "unavailable", status: 503 });
});

test("CLI check id emits only the selected source result", async () => {
  const registry = new LookoutRegistry([source("first"), source("second")]);
  const output = capture();
  await runCli({
    argv: ["check", "second"], stdout: output, stderr: capture(),
    loadRegistry: async () => registry, runner: runnerFor([result("second", "changed")]),
  });
  assert.equal(JSON.parse(output.value).sourceId, "second");
  assert.equal(output.value.trimEnd().split("\n").length, 1);
});

test("CLI rejects id plus --all before invoking the runner", async () => {
  let calls = 0;
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["check", "alpha", "--all"], stdout: capture(), stderr,
    loadRegistry: async () => { calls += 1; return new LookoutRegistry([]); },
  });
  assert.equal(exitCode, 2);
  assert.equal(calls, 0);
  assert.match(stderr.value, /mutually exclusive/);
});

test("CLI uses nonzero exit for an unreadable or invalid registry", async () => {
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["check", "--all"], stdout: capture(), stderr,
    loadRegistry: async () => { throw new Error("registry unreadable"); },
  });
  assert.equal(exitCode, 1);
  assert.match(stderr.value, /registry unreadable/);
});

test("CLI stdout contains no human prose or snapshot bodies", async () => {
  const output = capture();
  await runCli({
    argv: ["check", "alpha"], stdout: output, stderr: capture(),
    loadRegistry: async () => new LookoutRegistry([source("alpha")]),
    runner: runnerFor([result("alpha", "changed")]),
  });
  assert.doesNotMatch(output.value, /checking|complete|secret body/i);
  assert.deepEqual(Object.keys(JSON.parse(output.value)).includes("body"), false);
});

function capture() {
  return {
    value: "",
    write(chunk: string | Uint8Array) { this.value += chunk.toString(); return true; },
  };
}

function common(id: string) {
  return { sourceId: id, sourceUrl: `https://example.test/${id}`, checkedAt: "2026-07-10T12:00:00.000Z", warnings: [] };
}

function result(id: string, kind: "changed" | "unchanged-hash"): CheckResult {
  return kind === "changed"
    ? { ...common(id), kind, priorSnapshotRef: null, currentSnapshotRef: `traverse-snapshot:${id}`, changeBasis: "initial" }
    : { ...common(id), kind, priorSnapshotRef: `traverse-snapshot:${id}-old`, currentSnapshotRef: `traverse-snapshot:${id}-new` };
}

function runnerFor(results: CheckResult[]): CheckRunner {
  return {
    async check(sourceValue) {
      const found = results.find((item) => item.sourceId === sourceValue.id);
      if (!found) throw new Error(`missing result for ${sourceValue.id}`);
      return found;
    },
    async checkAll() { return results; },
  };
}
