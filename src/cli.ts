import type { Writable } from "node:stream";
import { open } from "node:fs/promises";
import type { ExtractionProposal } from "@kontourai/traverse";
import { createCheckRunner, type CheckRunner } from "./check-runner.js";
import { loadRegistry, type LookoutRegistry } from "./registry.js";
import { createLookoutSnapshotStore } from "./snapshot-store.js";
import { createObservationStore } from "./observation-store.js";
import { createDriftEmitter, type DriftResult } from "./drift-emission.js";
import type { ProposalSetObservation } from "./proposal-diff.js";

export interface RunCliOptions {
  argv?: string[];
  stdout?: Pick<Writable, "write">;
  stderr?: Pick<Writable, "write">;
  loadRegistry?: (path?: string) => Promise<LookoutRegistry>;
  runner?: CheckRunner;
  readObservation?: (path: string) => Promise<unknown>;
  emitDrift?: (sourceId: string, value: unknown, registry: LookoutRegistry, observationRoot?: string) => Promise<DriftResult>;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    stderr.write(`${parsed}\n`);
    return 2;
  }

  let registry: LookoutRegistry;
  try {
    registry = await (options.loadRegistry ?? loadRegistry)(parsed.registryPath);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.command === "emit-drift") {
    const source = registry.get(parsed.id);
    if (!source) { stderr.write(`Unknown source id: ${parsed.id}\n`); return 1; }
    let value: unknown;
    try { value = await (options.readObservation ?? readObservation)(parsed.observationPath); }
    catch (error) { stderr.write(`Could not read observation: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
    const result = await (options.emitDrift ?? emitDrift)(parsed.id, value, registry, parsed.observationRoot);
    if (!result.ok) { stderr.write(`${result.error.kind}: ${result.error.message}\n`); return 1; }
    stdout.write(`${JSON.stringify(result.value)}\n`);
    return 0;
  }

  const runner = options.runner ?? createCheckRunner({
    store: createLookoutSnapshotStore(parsed.snapshotRoot),
  });

  if (parsed.all) {
    const results = await runner.checkAll(registry.list());
    for (const result of results) stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const source = registry.get(parsed.id as string);
  if (!source) {
    stderr.write(`Unknown source id: ${parsed.id}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify(await runner.check(source))}\n`);
  return 0;
}

interface ParsedCheckArgs {
  command: "check";
  id?: string;
  all: boolean;
  registryPath?: string;
  snapshotRoot?: string;
}
interface ParsedEmitArgs { command: "emit-drift"; id: string; registryPath?: string; observationPath: string; observationRoot?: string }
type ParsedArgs = ParsedCheckArgs | ParsedEmitArgs;

function parseArgs(argv: string[]): ParsedArgs | string {
  if (argv[0] === "emit-drift") return parseEmitArgs(argv);
  if (argv[0] !== "check") return "Usage: lookout check <id>|--all [--registry path] [--snapshot-root path]\n       lookout emit-drift <id> --observation <path|-> [--registry path] [--observation-root path]";
  const parsed: ParsedCheckArgs = { command: "check", all: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      if (parsed.all) return "--all may be specified only once";
      parsed.all = true;
    } else if (arg === "--registry" || arg === "--snapshot-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return `${arg} requires a path`;
      if (arg === "--registry") parsed.registryPath = value;
      else parsed.snapshotRoot = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      return `Unknown option: ${arg}`;
    } else if (parsed.id) {
      return "Only one source id may be checked at a time";
    } else {
      parsed.id = arg;
    }
  }
  if (parsed.all && parsed.id) return "A source id and --all are mutually exclusive";
  if (!parsed.all && !parsed.id) return "check requires a source id or --all";
  return parsed;
}

function parseEmitArgs(argv: string[]): ParsedEmitArgs | string {
  let id: string | undefined; let observationPath: string | undefined; let registryPath: string | undefined; let observationRoot: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--registry" || arg === "--observation" || arg === "--observation-root") {
      const value = argv[++index]; if (!value || (value.startsWith("--") && value !== "-")) return `${arg} requires a path`;
      if (arg === "--registry") registryPath = value; else if (arg === "--observation") observationPath = value; else observationRoot = value;
    } else if (arg.startsWith("--")) return `Unknown option: ${arg}`;
    else if (id) return "Only one source id may be emitted at a time"; else id = arg;
  }
  if (!id) return "emit-drift requires a source id";
  if (!observationPath) return "emit-drift requires --observation <path|->";
  return { command: "emit-drift", id, observationPath, registryPath, observationRoot };
}

async function readObservation(file: string): Promise<unknown> {
  const maxBytes = 1024 * 1024;
  const text = file === "-" ? await new Promise<string>((resolve, reject) => { let body = ""; let bytes = 0; let rejected = false; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk: string) => { if (rejected) return; bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) { rejected = true; reject(new Error(`observation exceeds ${maxBytes} bytes`)); return; } body += chunk; }); process.stdin.on("end", () => { if (!rejected) resolve(body); }); process.stdin.on("error", reject); }) : await readBoundedFile(file, maxBytes);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`observation exceeds ${maxBytes} bytes`);
  return JSON.parse(text);
}

async function readBoundedFile(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`observation exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

type CliEntity = { key: string; proposals: readonly ExtractionProposal[] };
function cliEntities(observation: ProposalSetObservation): readonly CliEntity[] {
  const grouped = new Map<string, ExtractionProposal[]>();
  for (const proposal of observation.proposals) {
    const key = proposal.pathIndices?.length ? proposal.pathIndices.join(".") : "root";
    grouped.set(key, [...(grouped.get(key) ?? []), proposal]);
  }
  return [...grouped].map(([key, proposals]) => ({ key, proposals }));
}
async function emitDrift(sourceId: string, value: unknown, registry: LookoutRegistry, observationRoot?: string): Promise<DriftResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: { kind: "invalid-input", message: "Observation document must be an object" } };
  const document = value as { observation?: ProposalSetObservation; check?: import("./observation-store.js").ObservationCheckAnchor };
  const source = registry.get(sourceId)!;
  return createDriftEmitter<CliEntity>({ store: createObservationStore({ root: observationRoot }) }).emit({ source, current: document.observation as ProposalSetObservation, check: document.check as import("./observation-store.js").ObservationCheckAnchor, callbacks: { selectEntities: cliEntities, entityIdentity: (entity) => entity.key, proposalsFor: (entity) => entity.proposals, fieldIdentity: (_entity, proposal) => proposal.fieldPath } });
}
