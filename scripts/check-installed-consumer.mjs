import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "lookout-consumer-"));
const cache = path.join(temporary, "npm-cache");

try {
  const { stdout } = await execFileAsync("npm", [
    "pack", "--json", "--pack-destination", temporary, "--cache", cache,
  ], { cwd: root, maxBuffer: 1024 * 1024 * 10 });
  const packed = JSON.parse(stdout);
  if (packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("Expected npm pack to produce one archive");
  }
  const archive = path.join(temporary, packed[0].filename);
  await writeFile(path.join(temporary, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }), "utf8");
  await execFileAsync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache,
    archive, "typescript@5.8.3",
  ], { cwd: temporary, maxBuffer: 1024 * 1024 * 10 });
  await writeFile(path.join(temporary, "consumer.ts"), `
import {
  admitSourceCapture,
  admitSourceCheck,
  buildSemanticReviewWork,
  createObserveExtractDiff,
  createObservationStore,
  type LookoutSource,
  type ProposalSetObservation,
} from "@kontourai/lookout";

const source = {} as LookoutSource;
const observation = {} as ProposalSetObservation;
void source;
void observation;
void buildSemanticReviewWork;
void createObserveExtractDiff;
void createObservationStore;
void admitSourceCapture;
void admitSourceCheck;
`, "utf8");
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"],
      noEmit: true,
    },
    include: ["consumer.ts"],
  }), "utf8");
  await execFileAsync(path.join(temporary, "node_modules", ".bin", "tsc"), [
    "-p", path.join(temporary, "tsconfig.json"),
  ], { cwd: temporary, maxBuffer: 1024 * 1024 * 20 });
  // Exercise the NEW exports from the installed tarball against an actual
  // public Forage store, not merely type-check the older consumer imports.
  await writeFile(path.join(temporary, "admission-consumer.mjs"), `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInMemorySnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { admitSourceCapture, admitSourceCheck } from "@kontourai/lookout";
const source = { id: "sample", url: "https://example.test/sample", kind: "structured-file", format: "json", cadenceHint: "daily" };
const store = createInMemorySnapshotStore();
const value = { sourceId: source.id, url: source.url, status: 200, body: "sample", bodyHash: createHash("sha256").update("sample").digest("hex"), fetchedAt: "2026-08-26T00:00:00.000Z" };
await store.put(value);
const ref = buildSnapshotSourceRef(value);
const capture = await admitSourceCapture({ source, snapshotRef: ref, snapshotStore: store });
assert.equal(capture.ok, true);
assert.equal(capture.value.capture.bodyHash, value.bodyHash);
const check = { sourceId: source.id, sourceUrl: source.url, checkedAt: "2026-08-26T01:00:00.000Z", warnings: [], kind: "changed", priorSnapshotRef: null, currentSnapshotRef: ref, changeBasis: "initial" };
assert.equal((await admitSourceCheck({ source, check, expectedPriorSnapshotRef: null, snapshotStore: store })).ok, true);
assert.equal((await admitSourceCheck({ source, check: { ...check, kind: "unknown" }, expectedPriorSnapshotRef: null, snapshotStore: store })).ok, false);
`, "utf8");
  await execFileAsync(process.execPath, [path.join(temporary, "admission-consumer.mjs")], {
    cwd: temporary, maxBuffer: 1024 * 1024,
  });
  const installed = JSON.parse(await readFile(
    path.join(temporary, "node_modules", "@kontourai", "lookout", "package.json"),
    "utf8",
  ));
  console.log(`Lookout installed-consumer check passed for ${installed.version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
