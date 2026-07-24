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
  const installed = JSON.parse(await readFile(
    path.join(temporary, "node_modules", "@kontourai", "lookout", "package.json"),
    "utf8",
  ));
  console.log(`Lookout installed-consumer check passed for ${installed.version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
