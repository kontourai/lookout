import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { ExtractionProposal } from "@kontourai/traverse";
import type { ProposalSetObservation } from "./proposal-diff.js";

export interface ObservationCheckAnchor {
  readonly checkedAt: string;
  readonly resultKind: "changed" | "unchanged-hash";
  readonly currentSnapshotRef: string;
}

export interface ProposalObservationRecordInput {
  readonly observation: ProposalSetObservation;
  readonly recordedAt: string;
  readonly check: ObservationCheckAnchor;
}

export interface StoredProposalObservationV1 {
  readonly version: 1;
  readonly observationId: string;
  readonly sourceKey: string;
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly check: ObservationCheckAnchor;
  readonly proposals: readonly ExtractionProposal[];
}

export type ObservationStoreErrorKind = "invalid-input" | "corrupt-state" | "continuity-conflict" | "io-error";
export interface ObservationStoreError { readonly kind: ObservationStoreErrorKind; readonly message: string; readonly cause?: unknown }
export type ObservationStoreResult<T> = { readonly ok: true; readonly value: T; readonly warnings?: readonly string[] } | { readonly ok: false; readonly error: ObservationStoreError };

export interface ObservationStore {
  loadLatest(sourceId: string): Promise<ObservationStoreResult<StoredProposalObservationV1 | null>>;
  commit(input: ProposalObservationRecordInput, expectedPriorId: string | null): Promise<ObservationStoreResult<StoredProposalObservationV1>>;
}

export interface ObservationStoreFaults {
  readonly beforeSerialize?: () => void;
  readonly beforeTempWrite?: (kind: "record" | "pointer") => void;
  readonly beforeFileSync?: (kind: "record" | "pointer") => void;
  readonly beforeRecordRename?: () => void;
  readonly beforePointerRename?: () => void;
  readonly beforeDirectorySync?: (kind: "record" | "pointer") => void;
  readonly beforePrune?: () => void;
}
export interface CreateObservationStoreOptions { readonly root?: string; readonly faults?: ObservationStoreFaults }

function sourceKey(sourceId: string): string {
  return `${encodeURIComponent(sourceId).replaceAll("%", "_").slice(0, 48)}-${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function canonical(value: unknown): string { return `${JSON.stringify(stable(value))}\n`; }
function digest(body: Omit<StoredProposalObservationV1, "observationId">): string { return createHash("sha256").update(canonical(body)).digest("hex"); }

function buildRecord(input: ProposalObservationRecordInput): ObservationStoreResult<StoredProposalObservationV1> {
  try {
  const { observation, check } = input;
  if (!observation || typeof observation.sourceId !== "string" || observation.sourceId === "" || typeof observation.snapshotRef !== "string" || observation.snapshotRef === "" || typeof observation.observedAt !== "string" || observation.observedAt === "" || !Array.isArray(observation.proposals) || observation.proposals.some((proposal) => !validProposal(proposal))) {
    return { ok: false, error: { kind: "invalid-input", message: "Current proposal observation is malformed" } };
  }
  if (!check || check.currentSnapshotRef !== observation.snapshotRef || typeof check.checkedAt !== "string" || (check.resultKind !== "changed" && check.resultKind !== "unchanged-hash") || typeof input.recordedAt !== "string") {
    return { ok: false, error: { kind: "invalid-input", message: "Check anchor must match the current observation snapshot" } };
  }
  const proposals = [...observation.proposals].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const body = { version: 1 as const, sourceKey: sourceKey(observation.sourceId), sourceId: observation.sourceId, snapshotRef: observation.snapshotRef, observedAt: observation.observedAt, recordedAt: input.recordedAt, check, proposals };
  try { return { ok: true, value: { ...body, observationId: digest(body) } }; }
  catch (cause) { return { ok: false, error: { kind: "invalid-input", message: "Observation could not be serialized", cause } }; }
  } catch (cause) { return { ok: false, error: { kind: "invalid-input", message: "Current proposal observation could not be inspected", cause } }; }
}

function validProposal(value: unknown): value is ExtractionProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.fieldPath !== "string" || item.fieldPath === "" || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || typeof item.extractor !== "string" || item.extractor === "") return false;
  if (item.pathIndices !== undefined && (!Array.isArray(item.pathIndices) || item.pathIndices.some((part) => !Number.isSafeInteger(part) || (part as number) < 0))) return false;
  if (!item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)) return false;
  const provenance = item.provenance as Record<string, unknown>;
  return typeof provenance.locator === "string" && provenance.locator !== "" && typeof provenance.excerpt === "string";
}

function validate(value: unknown, expectedSourceId: string): ObservationStoreResult<StoredProposalObservationV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: { kind: "corrupt-state", message: "Stored observation is not an object" } };
  const item = value as Partial<StoredProposalObservationV1>;
  if (item.version !== 1 || item.sourceId !== expectedSourceId || item.sourceKey !== sourceKey(expectedSourceId) || typeof item.observationId !== "string" || !/^[a-f0-9]{64}$/.test(item.observationId) || typeof item.snapshotRef !== "string" || item.snapshotRef === "" || typeof item.observedAt !== "string" || item.observedAt === "" || typeof item.recordedAt !== "string" || item.recordedAt === "" || !Array.isArray(item.proposals) || item.proposals.some((proposal) => !validProposal(proposal)) || !item.check || typeof item.check !== "object" || typeof item.check.checkedAt !== "string" || item.check.checkedAt === "" || (item.check.resultKind !== "changed" && item.check.resultKind !== "unchanged-hash") || item.check.currentSnapshotRef !== item.snapshotRef) {
    return { ok: false, error: { kind: "corrupt-state", message: "Stored observation schema or continuity is invalid" } };
  }
  const { observationId, ...body } = item as StoredProposalObservationV1;
  try {
    if (digest(body) !== observationId) return { ok: false, error: { kind: "corrupt-state", message: "Stored observation digest does not match its body" } };
  } catch (cause) { return { ok: false, error: { kind: "corrupt-state", message: "Stored observation is not serializable", cause } }; }
  return { ok: true, value: item as StoredProposalObservationV1 };
}

async function rejectSymlink(file: string, allowMissing = true): Promise<void> {
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${file}`); }
  catch (cause) { if (allowMissing && (cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
}
async function syncDirectory(dir: string, fault?: () => void): Promise<void> { fault?.(); const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } }
interface AtomicWriteOutcome { readonly renamed: true; readonly durabilityWarning?: string }
async function atomicWrite(file: string, bytes: string, kind: "record" | "pointer", faults?: ObservationStoreFaults): Promise<AtomicWriteOutcome> {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await rejectSymlink(file);
  faults?.beforeTempWrite?.(kind);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8"); faults?.beforeFileSync?.(kind); await handle.sync(); await handle.close(); kind === "record" ? faults?.beforeRecordRename?.() : faults?.beforePointerRename?.(); await rename(temp, file);
    try { await syncDirectory(path.dirname(file), () => faults?.beforeDirectorySync?.(kind)); return { renamed: true }; }
    catch (cause) { return { renamed: true, durabilityWarning: `${kind} rename completed but directory fsync failed: ${cause instanceof Error ? cause.message : String(cause)}` }; }
  }
  catch (error) { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); throw error; }
}

export function createObservationStore(options: CreateObservationStoreOptions = {}): ObservationStore {
  const root = options.root ?? path.join(process.cwd(), ".kontourai", "lookout", "observations");
  async function loadLatest(sourceId: string): Promise<ObservationStoreResult<StoredProposalObservationV1 | null>> {
    try {
      const dir = path.join(root, sourceKey(sourceId));
      await rejectSymlink(root); await rejectSymlink(dir);
      let pointerText: string;
      const pointerPath = path.join(dir, "latest.json");
      try { await rejectSymlink(pointerPath); pointerText = await readFile(pointerPath, "utf8"); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: null }; throw cause; }
      const pointer = JSON.parse(pointerText) as { version?: unknown; sourceId?: unknown; observationId?: unknown };
      if (pointer.version !== 1 || pointer.sourceId !== sourceId || typeof pointer.observationId !== "string" || !/^[a-f0-9]{64}$/.test(pointer.observationId)) return { ok: false, error: { kind: "corrupt-state", message: "Latest pointer is invalid" } };
      const recordPath = path.join(dir, `${pointer.observationId}.json`); await rejectSymlink(recordPath);
      const parsed: unknown = JSON.parse(await readFile(recordPath, "utf8"));
      const checked = validate(parsed, sourceId);
      if (!checked.ok) return checked;
      if (checked.value.observationId !== pointer.observationId) return { ok: false, error: { kind: "corrupt-state", message: "Latest pointer does not match the record" } };
      return checked;
    } catch (cause) { return { ok: false, error: { kind: "io-error", message: "Could not load latest observation", cause } }; }
  }

  async function commit(input: ProposalObservationRecordInput, expectedPriorId: string | null): Promise<ObservationStoreResult<StoredProposalObservationV1>> {
    let made: ObservationStoreResult<StoredProposalObservationV1>;
    try { options.faults?.beforeSerialize?.(); made = buildRecord(input); } catch (cause) { return { ok: false, error: { kind: "invalid-input", message: "Observation serialization failed", cause } }; }
    if (!made.ok) return made;
    const record = made.value; const dir = path.join(root, record.sourceKey); const lockPath = path.join(dir, ".lock");
    try { await rejectSymlink(root); await mkdir(root, { recursive: true }); await rejectSymlink(root, false); await rejectSymlink(dir); await mkdir(dir, { recursive: true }); await rejectSymlink(dir, false); await rejectSymlink(lockPath); }
    catch (cause) { return { ok: false, error: { kind: "io-error", message: "Could not prepare observation directory", cause } }; }
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (cause) { return (cause as NodeJS.ErrnoException).code === "EEXIST" ? { ok: false, error: { kind: "continuity-conflict", message: "Another writer holds the source lock", cause } } : { ok: false, error: { kind: "io-error", message: "Could not acquire source lock", cause } }; }
    const recordPath = path.join(dir, `${record.observationId}.json`); let createdRecord = false; let pointerCommitted = false;
    try {
      const current = await loadLatest(record.sourceId);
      if (!current.ok) return current;
      if ((current.value?.observationId ?? null) !== expectedPriorId) return { ok: false, error: { kind: "continuity-conflict", message: "Latest observation changed before commit" } };
      const recordBytes = canonical(record);
      try { await rejectSymlink(recordPath); const existing = await readFile(recordPath, "utf8"); if (existing !== recordBytes) return { ok: false, error: { kind: "corrupt-state", message: "Digest-addressed record already exists with different bytes" } }; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        const installed = await atomicWrite(recordPath, recordBytes, "record", options.faults); createdRecord = installed.renamed;
        if (installed.durabilityWarning) { await rm(recordPath, { force: true }); await syncDirectory(dir); createdRecord = false; return { ok: false, error: { kind: "io-error", message: installed.durabilityWarning } }; }
      }
      const pointer = await atomicWrite(path.join(dir, "latest.json"), canonical({ version: 1, sourceId: record.sourceId, observationId: record.observationId }), "pointer", options.faults); pointerCommitted = pointer.renamed;
      const warnings: string[] = pointer.durabilityWarning ? [pointer.durabilityWarning] : [];
      try {
        options.faults?.beforePrune?.();
        const records = (await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
        const inspected = await Promise.all(records.map(async (name) => ({ name, text: await readFile(path.join(dir, name), "utf8") })));
        const valid = inspected.map(({ name, text }) => { try { const checked = validate(JSON.parse(text), record.sourceId); return checked.ok ? { name, recordedAt: checked.value.recordedAt, id: checked.value.observationId } : null; } catch { return null; } }).filter((item): item is { name: string; recordedAt: string; id: string } => item !== null);
        const preserve = new Set([record.observationId, expectedPriorId].filter((item): item is string => item !== null));
        const extras = valid.filter((item) => !preserve.has(item.id)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
        await Promise.all(extras.map((item) => rm(path.join(dir, item.name), { force: true })));
      } catch (cause) { warnings.push(`Observation committed but retention cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return { ok: true, value: record, ...(warnings.length ? { warnings } : {}) };
    } catch (cause) {
      if (createdRecord && !pointerCommitted) await rm(recordPath, { force: true }).catch(() => undefined);
      return { ok: false, error: { kind: "io-error", message: "Could not commit observation", cause } };
    } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined); }
  }
  return { loadLatest, commit };
}
