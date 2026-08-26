import type { SnapshotStore } from "@kontourai/forage";
import type { CheckResult } from "./check-result.js";
import type { LookoutSource } from "./registry.js";
import { resolveLookoutSnapshot } from "./snapshot-store.js";
import type { AdmittedSnapshotIdentity } from "./observation-admission.js";

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
  if (!captured) return fail("invalid-input", "Capture admission input is malformed");
  const value = await resolve(captured.source, captured.snapshotRef, captured.snapshotStore, true);
  return value.ok ? { ok: true, value: { capture: value.value } } : value;
}

/** Admit a genuine CheckRunner outcome; this validates relationships, not HTTP provenance. */
export async function admitSourceCheck(input: { source: LookoutSource; check: CheckResult; expectedPriorSnapshotRef: string | null; snapshotStore: SnapshotStore }): Promise<SourceAdmissionResult<AdmittedSourceCheck>> {
  const captured = captureCheck(input);
  if (!captured || !validCheck(captured.source, captured.check)) return fail("invalid-input", "Check admission input is malformed");
  const check = captured.check;
  if (check.kind === "error") return fail("invalid-input", "An error result has no successful capture");
  const refs = refsFor(check, captured.expectedPriorSnapshotRef);
  if (!refs) return fail("invalid-input", "Check references do not match the expected baseline");
  const current = await resolve(captured.source, refs.current, captured.snapshotStore, true);
  if (!current.ok) return current;
  const prior = refs.prior === null ? null : await resolve(captured.source, refs.prior, captured.snapshotStore, false);
  if (prior !== null && !prior.ok) return prior;
  if (check.kind === "unchanged-hash" && prior !== null && prior.ok && prior.value.bodyHash !== current.value.bodyHash) return fail("insufficient-binding", "Same-hash result does not bind equal snapshot bodies");
  if (check.kind === "changed" && check.changeBasis === "hash" && prior !== null && prior.ok && prior.value.bodyHash === current.value.bodyHash && prior.value.url === current.value.url) return fail("insufficient-binding", "Changed result does not bind a changed capture");
  return { ok: true, value: { prior: prior?.ok ? prior.value : null, current: current.value, checkedAt: check.checkedAt, resultKind: check.kind } };
}

function refsFor(check: Exclude<CheckResult, { kind: "error" }>, expected: string | null): { prior: string | null; current: string } | null {
  if (check.kind === "unchanged-304") return expected !== null && check.snapshotRef === expected ? { prior: expected, current: check.snapshotRef } : null;
  if (check.kind === "unchanged-hash") return check.priorSnapshotRef === expected ? { prior: expected, current: check.currentSnapshotRef } : null;
  return check.changeBasis === "initial" ? expected === null ? { prior: null, current: check.currentSnapshotRef } : null : check.priorSnapshotRef === expected && expected !== null ? { prior: expected, current: check.currentSnapshotRef } : null;
}
function validCheck(source: LookoutSource, check: CheckResult): boolean { return !!check && check.sourceId === source.id && check.sourceUrl === source.url && typeof check.checkedAt === "string" && check.checkedAt !== ""; }
function captureCapture(input: { source: LookoutSource; snapshotRef: string; snapshotStore: SnapshotStore }) { try { return { ...structuredClone({ source: input.source, snapshotRef: input.snapshotRef }), snapshotStore: input.snapshotStore }; } catch { return null; } }
function captureCheck(input: { source: LookoutSource; check: CheckResult; expectedPriorSnapshotRef: string | null; snapshotStore: SnapshotStore }) { try { return { ...structuredClone({ source: input.source, check: input.check, expectedPriorSnapshotRef: input.expectedPriorSnapshotRef }), snapshotStore: input.snapshotStore }; } catch { return null; } }
async function resolve(source: LookoutSource, ref: string, store: SnapshotStore, current: boolean): Promise<SourceAdmissionResult<AdmittedSnapshotIdentity>> {
  const resolved = await resolveLookoutSnapshot(ref, { store });
  if (!resolved.ok || resolved.snapshot.sourceId !== source.id) return fail("unresolved", "Snapshot reference could not be admitted");
  if (current && !sameUrl(source.url, resolved.snapshot.url, resolved.snapshot.redirects)) return fail("insufficient-binding", "Snapshot URL is not bound to the registered source");
  return { ok: true, value: { sourceId: source.id, snapshotRef: ref, url: resolved.snapshot.url, bodyHash: resolved.snapshot.bodyHash, fetchedAt: resolved.snapshot.fetchedAt, ...(resolved.reference.snapshotDigest ? { snapshotDigest: resolved.reference.snapshotDigest } : {}), integrity: resolved.integrity } };
}
function sameUrl(registered: string, final: string, redirects?: readonly string[]): boolean { try { const first = redirects?.[0] ?? final; return new URL(first).href === new URL(registered).href; } catch { return false; } }
function fail(kind: SourceAdmissionError["kind"], message: string): SourceAdmissionResult<never> { return { ok: false, error: { kind, message } }; }
