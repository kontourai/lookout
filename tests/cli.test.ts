import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("L3-AC9 emit-drift is separate, composable, and emits one success JSONL line", async () => {
  const output = capture();
  const exitCode = await runCli({
    argv: ["emit-drift", "alpha", "--observation", "-", "--observation-root", "/tmp/observations"], stdout: output, stderr: capture(),
    loadRegistry: async () => new LookoutRegistry([source("alpha")]), readObservation: async (file) => ({ file }),
    emitDrift: async (id, value, _registry, root) => ({ ok: true, value: { sourceId: id, events: [], facts: [], priorObservationId: null, committedObservation: { version: 1, observationId: "digest", sourceKey: "key", sourceId: id, snapshotRef: "snapshot", observedAt: "observed", recordedAt: "recorded", check: { checkedAt: "checked", resultKind: "changed", currentSnapshotRef: "snapshot" }, proposals: [] }, warnings: [`${(value as { file: string }).file}:${root}`] } }),
  });
  assert.equal(exitCode, 0);
  assert.equal(output.value.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(output.value).warnings, ["-:/tmp/observations"]);
});

test("L3-AC9 emit-drift failures write stderr, no stdout, and check rejects emission flags", async () => {
  const stdout = capture(); const stderr = capture();
  const failed = await runCli({ argv: ["emit-drift", "alpha", "--observation", "bad.json"], stdout, stderr, loadRegistry: async () => new LookoutRegistry([source("alpha")]), readObservation: async () => { throw new Error("malformed input"); } });
  assert.equal(failed, 1); assert.equal(stdout.value, ""); assert.match(stderr.value, /malformed input/);
  const checkError = capture();
  assert.equal(await runCli({ argv: ["check", "alpha", "--observation", "x"], stdout: capture(), stderr: checkError }), 2);
  assert.match(checkError.value, /Unknown option/);
});

test("L3-AC9 real CLI persists first/second observations and contains malformed, corrupt, unknown, and unwritable state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lookout-cli-"));
  try {
    await writeFile(path.join(cwd, "lookout.sources.json"), JSON.stringify({ version: 1, sources: [source("alpha")] }));
    const one = observationDocument("snapshot-1", "old"); const two = observationDocument("snapshot-2", "new");
    await writeFile(path.join(cwd, "one.json"), JSON.stringify(one)); await writeFile(path.join(cwd, "two.json"), JSON.stringify(two));
    const first = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "one.json"]);
    assert.deepEqual({ code: first.code, stderr: first.stderr }, { code: 0, stderr: "" }); assert.equal(first.stdout.trimEnd().split("\n").length, 1); assert.equal(JSON.parse(first.stdout).priorObservationId, null);
    const second = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "two.json"]);
    assert.deepEqual({ code: second.code, stderr: second.stderr }, { code: 0, stderr: "" }); assert.equal(JSON.parse(second.stdout).events.length, 1); assert.notEqual(JSON.parse(second.stdout).priorObservationId, null);
    const stdinRoot = path.join(cwd, "stdin-state"); const stdinFirst = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "-", "--observation-root", stdinRoot], JSON.stringify(one));
    assert.equal(stdinFirst.code, 0); assert.equal(JSON.parse(stdinFirst.stdout).priorObservationId, null);
    const unknown = await runLookout(cwd, ["emit-drift", "missing", "--observation", "one.json"]); assert.deepEqual({ code: unknown.code, stdout: unknown.stdout, stderr: unknown.stderr }, { code: 1, stdout: "", stderr: "Unknown source id: missing\n" });
    await writeFile(path.join(cwd, "bad.json"), "{"); const malformed = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "bad.json"]); assert.equal(malformed.code, 1); assert.equal(malformed.stdout, ""); assert.match(malformed.stderr, /^Could not read observation:/);
    const stateRoot = path.join(cwd, ".kontourai", "lookout", "observations"); const sourceDir = path.join(stateRoot, (await readdir(stateRoot))[0]!); const pointer = JSON.parse(await readFile(path.join(sourceDir, "latest.json"), "utf8")); await writeFile(path.join(sourceDir, `${pointer.observationId}.json`), "{}");
    const corrupt = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "two.json"]); assert.equal(corrupt.code, 1); assert.equal(corrupt.stdout, ""); assert.match(corrupt.stderr, /^prior-state-error:/);
    const outside = path.join(cwd, "outside"); await writeFile(outside, "marker"); const linkedRoot = path.join(cwd, "linked-root"); await symlink(outside, linkedRoot);
    const unwritable = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "one.json", "--observation-root", linkedRoot]); assert.equal(unwritable.code, 1); assert.equal(unwritable.stdout, ""); assert.match(unwritable.stderr, /^prior-state-error:/); assert.equal(await readFile(outside, "utf8"), "marker");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("final security remediation: oversized file and stdin are exact failures and never advance state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lookout-cli-bounded-"));
  try {
    await writeFile(path.join(cwd, "lookout.sources.json"), JSON.stringify({ version: 1, sources: [source("alpha")] })); await writeFile(path.join(cwd, "one.json"), JSON.stringify(observationDocument("snapshot-1", "old")));
    const first = await runLookout(cwd, ["emit-drift", "alpha", "--observation", "one.json"]); assert.equal(first.code, 0);
    const stateRoot = path.join(cwd, ".kontourai", "lookout", "observations"); const sourceDir = path.join(stateRoot, (await readdir(stateRoot))[0]!); const pointerPath = path.join(sourceDir, "latest.json"); const before = await readFile(pointerPath);
    const oversized = " ".repeat(1024 * 1024 + 1); await writeFile(path.join(cwd, "large.json"), oversized);
    for (const [argv, stdin] of [[["emit-drift", "alpha", "--observation", "large.json"], undefined], [["emit-drift", "alpha", "--observation", "-"], oversized]] as const) {
      const result = await runLookout(cwd, [...argv], stdin); assert.deepEqual(result, { code: 1, stdout: "", stderr: "Could not read observation: observation exceeds 1048576 bytes\n" }); assert.deepEqual(await readFile(pointerPath), before);
    }
    const sourceText = await readFile(path.join(process.cwd(), "src", "cli.ts"), "utf8"); assert.doesNotMatch(sourceText, /readFile\(file/); assert.match(sourceText, /maxBytes \+ 1/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
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

function observationDocument(snapshotRef: string, value: string) {
  return { observation: { sourceId: "alpha", snapshotRef, observedAt: `${snapshotRef}-time`, proposals: [{ fieldPath: "entries[].value", pathIndices: [0], candidateValue: value, confidence: 0.9, provenance: { locator: "chars:0-3", excerpt: value }, extractor: "example-extractor:v1" }] }, check: { checkedAt: `${snapshotRef}-checked`, resultKind: "changed", currentSnapshotRef: snapshotRef } };
}

async function runLookout(cwd: string, argv: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "bin", "lookout.mjs"), ...argv], { cwd, stdio: "pipe" }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr })); child.stdin.end(stdin);
  });
}
