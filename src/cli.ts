import type { Writable } from "node:stream";
import { createCheckRunner, type CheckRunner } from "./check-runner.js";
import { loadRegistry, type LookoutRegistry } from "./registry.js";
import { createLookoutSnapshotStore } from "./snapshot-store.js";

export interface RunCliOptions {
  argv?: string[];
  stdout?: Pick<Writable, "write">;
  stderr?: Pick<Writable, "write">;
  loadRegistry?: (path?: string) => Promise<LookoutRegistry>;
  runner?: CheckRunner;
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

interface ParsedArgs {
  id?: string;
  all: boolean;
  registryPath?: string;
  snapshotRoot?: string;
}

function parseArgs(argv: string[]): ParsedArgs | string {
  if (argv[0] !== "check") return "Usage: lookout check <id>|--all [--registry path] [--snapshot-root path]";
  const parsed: ParsedArgs = { all: false };
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
