import type { SnapshotStore } from "@kontourai/forage";
import { parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { CheckResult } from "./check-result.js";
import {
  captureExactSnapshotReader,
  normalizedHttpUrl,
  snapshotSourceBinding,
  type AdmittedSnapshotIdentity,
} from "./observation-admission.js";
import { parseRegistry, type LookoutSource } from "./registry.js";
import { resolveLookoutSnapshot } from "./snapshot-store.js";

export type SourceAdmissionError = {
  readonly kind: "invalid-input" | "unresolved" | "insufficient-binding";
  readonly message: string;
};
export type SourceAdmissionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SourceAdmissionError };

export interface AdmittedSourceCapture {
  readonly capture: AdmittedSnapshotIdentity;
}
export interface AdmittedSourceCheck {
  readonly prior: AdmittedSnapshotIdentity | null;
  readonly current: AdmittedSnapshotIdentity;
  readonly checkedAt: string;
  readonly resultKind: Exclude<CheckResult["kind"], "error">;
}

/** Metadata-only capture admission; it neither fetches nor persists. */
export async function admitSourceCapture(input: { source: LookoutSource; snapshotRef: string; snapshotStore: SnapshotStore }): Promise<SourceAdmissionResult<AdmittedSourceCapture>> {
  const captured = captureCapture(input);
  if (!captured || !validSource(captured.source) || !canonicalRef(captured.snapshotRef)) return fail("invalid-input", "Capture admission input is malformed");
  const value = await resolve(captured.source, captured.snapshotRef, captured.snapshotStore, true);
  return value.ok ? { ok: true, value: { capture: value.value } } : value;
}

/** Admit a genuine CheckRunner outcome; this validates relationships, not HTTP provenance. */
export async function admitSourceCheck(input: { source: LookoutSource; check: CheckResult; expectedPriorSnapshotRef: string | null; snapshotStore: SnapshotStore }): Promise<SourceAdmissionResult<AdmittedSourceCheck>> {
  const captured = captureCheck(input);
  if (!captured || !validSource(captured.source) || !validCheck(captured.source, captured.check)) return fail("invalid-input", "Check admission input is malformed");
  const check = captured.check;
  if (check.kind === "error") return fail("invalid-input", "An error result has no successful capture");
  const refs = refsFor(check, captured.expectedPriorSnapshotRef);
  // Validate every durable reference before the first exact lookup: admission
  // never lets a malformed historical anchor cause partial capability I/O.
  if (!refs || !canonicalRef(refs.current) || (refs.prior !== null && !canonicalRef(refs.prior))) return fail("invalid-input", "Check references do not match the expected baseline");
  const current = await resolve(captured.source, refs.current, captured.snapshotStore, true);
  if (!current.ok) return current;
  const prior = refs.prior === null ? null : await resolve(captured.source, refs.prior, captured.snapshotStore, false);
  if (prior !== null && !prior.ok) return prior;
  if (check.kind === "unchanged-hash" && prior !== null && prior.ok && (prior.value.bodyHash !== current.value.bodyHash || prior.value.url !== current.value.url)) return fail("insufficient-binding", "Same-hash result does not bind one resource capture");
  if (check.kind === "changed" && check.changeBasis === "hash" && prior !== null && prior.ok && prior.value.bodyHash === current.value.bodyHash && prior.value.url === current.value.url) return fail("insufficient-binding", "Changed result does not bind a changed capture");
  return { ok: true, value: { prior: prior?.ok ? prior.value : null, current: current.value, checkedAt: check.checkedAt, resultKind: check.kind } };
}

function refsFor(check: Exclude<CheckResult, { kind: "error" }>, expected: string | null): { prior: string | null; current: string } | null {
  if (check.kind === "unchanged-304") return expected !== null && check.snapshotRef === expected ? { prior: expected, current: check.snapshotRef } : null;
  if (check.kind === "unchanged-hash") return check.priorSnapshotRef === expected ? { prior: expected, current: check.currentSnapshotRef } : null;
  return check.changeBasis === "initial"
    ? expected === null ? { prior: null, current: check.currentSnapshotRef } : null
    : check.priorSnapshotRef === expected && expected !== null ? { prior: expected, current: check.currentSnapshotRef } : null;
}

function validSource(source: LookoutSource): boolean {
  try {
    if (!source || typeof source !== "object" || normalizedHttpUrl(source.url) === null) return false;
    parseRegistry({ version: 1, sources: [source] });
    return true;
  } catch {
    return false;
  }
}

function validCheck(source: LookoutSource, check: CheckResult): boolean {
  if (!check || typeof check !== "object" || Array.isArray(check)) return false;
  const common = () => check.sourceId === source.id && check.sourceUrl === source.url && validTimestamp(check.checkedAt) && validWarnings(check.warnings);
  if (check.kind === "unchanged-304") return closed(check, ["sourceId", "sourceUrl", "checkedAt", "warnings", "kind", "snapshotRef"]) && common() && typeof check.snapshotRef === "string";
  if (check.kind === "unchanged-hash") return closed(check, ["sourceId", "sourceUrl", "checkedAt", "warnings", "kind", "priorSnapshotRef", "currentSnapshotRef"]) && common() && typeof check.priorSnapshotRef === "string" && typeof check.currentSnapshotRef === "string";
  if (check.kind === "changed") return closed(check, ["sourceId", "sourceUrl", "checkedAt", "warnings", "kind", "priorSnapshotRef", "currentSnapshotRef", "changeBasis"]) && common() && typeof check.currentSnapshotRef === "string" && (check.changeBasis === "initial" || check.changeBasis === "hash") && (check.changeBasis === "initial" ? check.priorSnapshotRef === null : typeof check.priorSnapshotRef === "string");
  return false;
}

function closed(value: object, keys: readonly string[]): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validWarnings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}

function canonicalRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseSnapshotSourceRef(value);
  if (!parsed || !/^[a-f0-9]{64}$/.test(parsed.bodyHash) || (parsed.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(parsed.snapshotDigest))) return false;
  const query = new URLSearchParams({ url: parsed.url, sha256: parsed.bodyHash, fetchedAt: parsed.fetchedAt });
  if (parsed.snapshotDigest !== undefined) query.set("snapshotSha256", parsed.snapshotDigest);
  return value === `forage-snapshot:${encodeURIComponent(parsed.sourceId)}?${query.toString()}`;
}

function captureCapture(input: { source: LookoutSource; snapshotRef: string; snapshotStore: SnapshotStore }) {
  try {
    if (!input || typeof input !== "object") return null;
    const snapshotStore = captureExactSnapshotReader(input.snapshotStore);
    return snapshotStore === null ? null : { ...structuredClone({ source: input.source, snapshotRef: input.snapshotRef }), snapshotStore };
  } catch { return null; }
}

function captureCheck(input: { source: LookoutSource; check: CheckResult; expectedPriorSnapshotRef: string | null; snapshotStore: SnapshotStore }) {
  try {
    if (!input || typeof input !== "object") return null;
    const snapshotStore = captureExactSnapshotReader(input.snapshotStore);
    return snapshotStore === null ? null : { ...structuredClone({ source: input.source, check: input.check, expectedPriorSnapshotRef: input.expectedPriorSnapshotRef }), snapshotStore };
  } catch { return null; }
}

async function resolve(source: LookoutSource, ref: string, store: SnapshotStore, current: boolean): Promise<SourceAdmissionResult<AdmittedSnapshotIdentity>> {
  const resolved = await resolveLookoutSnapshot(ref, { store });
  if (!resolved.ok || resolved.snapshot.sourceId !== source.id) return fail("unresolved", "Snapshot reference could not be admitted");
  const binding = snapshotSourceBinding(source.url, resolved.snapshot.url, resolved.snapshot.redirects, resolved.integrity, current);
  if (binding !== null) return fail("insufficient-binding", binding === "redirect-binding" ? "Snapshot redirect capture is not admissibly bound" : "Snapshot URL is not bound to the registered source");
  return { ok: true, value: { sourceId: source.id, snapshotRef: ref, url: resolved.snapshot.url, bodyHash: resolved.snapshot.bodyHash, fetchedAt: resolved.snapshot.fetchedAt, ...(resolved.reference.snapshotDigest ? { snapshotDigest: resolved.reference.snapshotDigest } : {}), integrity: resolved.integrity } };
}

function fail(kind: SourceAdmissionError["kind"], message: string): SourceAdmissionResult<never> {
  return { ok: false, error: { kind, message } };
}
