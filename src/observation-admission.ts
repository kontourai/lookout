import type { SnapshotStore } from "@kontourai/forage";
import type { LookoutSource } from "./registry.js";
import type { StoredProposalObservationV1, ObservationCheckAnchor } from "./observation-store.js";
import type { ProposalSetObservation } from "./proposal-diff.js";
import { resolveLookoutSnapshot } from "./snapshot-store.js";

/** A resolved snapshot identity suitable for durable observation metadata. */
export interface AdmittedSnapshotIdentity {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly url: string;
  readonly bodyHash: string;
  readonly fetchedAt: string;
  /** Present only for Forage envelope-integrity references; never synthesized for legacy refs. */
  readonly snapshotDigest?: string;
  readonly integrity: "snapshot-envelope" | "body-and-identity";
}

export interface AdmittedProposalObservation {
  readonly current: AdmittedSnapshotIdentity;
  readonly prior: AdmittedSnapshotIdentity | null;
}

export type ObservationAdmissionErrorKind = "invalid-input" | "current-unresolved" | "prior-unresolved" | "insufficient-binding";
export interface ObservationAdmissionError {
  readonly kind: ObservationAdmissionErrorKind;
  readonly classification: "invalid-reference" | "not-found" | "mismatch" | "corrupt" | "store" | "source-identity" | "url-binding" | "redirect-binding";
  readonly message: string;
}
export type ObservationAdmissionResult = { readonly ok: true; readonly value: AdmittedProposalObservation } | { readonly ok: false; readonly error: ObservationAdmissionError };

/** A stable exact-reader capability, captured before asynchronous admission begins. */
export function captureExactSnapshotReader(store: SnapshotStore): SnapshotStore | null {
  try {
    if (!store || typeof store !== "object" || typeof store.findExact !== "function") return null;
    const findExact = store.findExact.bind(store);
    return { findExact } as SnapshotStore;
  } catch {
    return null;
  }
}

export type SnapshotSourceBinding = "url-binding" | "redirect-binding";

/**
 * Bind an authenticated snapshot to a registry source without exposing its
 * body. Historical direct captures can predate a registry URL change, but a
 * legacy reference cannot authenticate any redirect capture.
 */
export function snapshotSourceBinding(
  registeredUrl: string,
  finalUrl: string,
  redirects: readonly string[] | undefined,
  integrity: "snapshot-envelope" | "body-and-identity",
  current: boolean,
): SnapshotSourceBinding | null {
  const registered = normalizedHttpUrl(registeredUrl);
  const final = normalizedHttpUrl(finalUrl);
  if (registered === null || final === null) return "url-binding";
  if (!redirects?.length) return !current || final === registered ? null : "url-binding";
  if (integrity !== "snapshot-envelope" || !validRedirectChain(redirects, finalUrl)) return "redirect-binding";
  return !current || normalizedHttpUrl(redirects[0]!) === registered ? null : "redirect-binding";
}

export interface AdmitProposalObservationInput {
  readonly source: LookoutSource;
  readonly current: ProposalSetObservation;
  readonly check: ObservationCheckAnchor;
  /** The already-selected observation-store record; admission never selects or persists continuity. */
  readonly prior: StoredProposalObservationV1 | null;
  /** Explicit capability: admission never chooses a snapshot root or storage implementation. */
  readonly snapshotStore: SnapshotStore;
}

/**
 * Authenticate proposal-observation snapshot references before they can be
 * diffed or committed.  It is deliberately metadata-only: it neither exposes
 * snapshot bodies nor reads/writes the observation store.
 */
export async function admitProposalObservation(input: AdmitProposalObservationInput): Promise<ObservationAdmissionResult> {
  try {
    // This is a public asynchronous boundary.  Capture every caller-owned
    // value before admission starts I/O so a caller cannot splice a later
    // reference, source identity, or anchor into the authenticated result.
    const invocation = captureInvocation(input);
    if (invocation === null) return failure("invalid-input", "source-identity", "Observation admission input is malformed");
    return await admit(invocation);
  }
  catch { return failure("invalid-input", "source-identity", "Observation admission input is malformed"); }
}

async function admit(invocation: AdmitProposalObservationInput): Promise<ObservationAdmissionResult> {
  if (!invocation || typeof invocation !== "object" || !invocation.source || typeof invocation.source !== "object" || !invocation.current || typeof invocation.current !== "object" || !invocation.check || typeof invocation.check !== "object" || !invocation.snapshotStore || typeof invocation.snapshotStore !== "object" ||
    typeof invocation.source.id !== "string" || typeof invocation.source.url !== "string" || typeof invocation.current.sourceId !== "string" || typeof invocation.current.snapshotRef !== "string" || typeof invocation.check.currentSnapshotRef !== "string" ||
    invocation.source.id !== invocation.current.sourceId || invocation.check.currentSnapshotRef !== invocation.current.snapshotRef) {
    return failure("invalid-input", "source-identity", "Registry source, observation, and check anchor must agree");
  }
  const registeredUrl = normalizedHttpUrl(invocation.source.url);
  if (registeredUrl === null) return failure("invalid-input", "url-binding", "Registered source URL is not an admissible HTTP URL");

  // resolveLookoutSnapshot delegates canonical reference validation to Forage;
  // its resolver validates before calling findExact, so malformed refs perform
  // no snapshot-store I/O.
  const current = await resolveLookoutSnapshot(invocation.current.snapshotRef, { store: invocation.snapshotStore });
  if (!current.ok) return resolutionFailure("current", current.error.kind);
  if (current.snapshot.sourceId !== invocation.source.id) return failure("invalid-input", "source-identity", "Current snapshot identity does not match the registered source");
  const currentBinding = bindCurrentSnapshot(current.snapshot.url, current.snapshot.redirects, current.integrity, registeredUrl);
  if (currentBinding !== null) return currentBinding;

  if (invocation.prior === null) return { ok: true, value: { current: identity(invocation.current.snapshotRef, current), prior: null } };
  if (!invocation.prior || typeof invocation.prior !== "object" || typeof invocation.prior.sourceId !== "string" || typeof invocation.prior.snapshotRef !== "string" || !invocation.prior.check || typeof invocation.prior.check !== "object" || typeof invocation.prior.check.currentSnapshotRef !== "string" ||
    invocation.prior.sourceId !== invocation.source.id || invocation.prior.check.currentSnapshotRef !== invocation.prior.snapshotRef) {
    return failure("invalid-input", "source-identity", "Prior observation identity is not valid for the registered source");
  }
  const prior = await resolveLookoutSnapshot(invocation.prior.snapshotRef, { store: invocation.snapshotStore });
  if (!prior.ok) return resolutionFailure("prior", prior.error.kind);
  if (prior.snapshot.sourceId !== invocation.source.id) return failure("invalid-input", "source-identity", "Prior snapshot identity does not match the registered source");
  // A historical capture may legitimately precede a registry URL change. It
  // still needs durable identity authentication, but is not rebound to today’s URL.
  if (prior.snapshot.redirects?.length && prior.integrity !== "snapshot-envelope") {
    return failure("insufficient-binding", "redirect-binding", "Legacy snapshot references cannot authenticate redirect captures");
  }
  if (prior.snapshot.redirects?.length && !validRedirectChain(prior.snapshot.redirects, prior.snapshot.url)) {
    return failure("insufficient-binding", "redirect-binding", "Snapshot redirect capture is not admissibly bound");
  }
  return { ok: true, value: { current: identity(invocation.current.snapshotRef, current), prior: identity(invocation.prior.snapshotRef, prior) } };
}

function identity(snapshotRef: string, resolved: Extract<Awaited<ReturnType<typeof resolveLookoutSnapshot>>, { ok: true }>): AdmittedSnapshotIdentity {
  return { sourceId: resolved.snapshot.sourceId, snapshotRef, url: resolved.snapshot.url, bodyHash: resolved.snapshot.bodyHash, fetchedAt: resolved.snapshot.fetchedAt, ...(resolved.reference.snapshotDigest === undefined ? {} : { snapshotDigest: resolved.reference.snapshotDigest }), integrity: resolved.integrity };
}
function resolutionFailure(side: "current" | "prior", kind: "invalid-reference" | "snapshot-not-found" | "snapshot-mismatch" | "snapshot-corrupt" | "snapshot-store-error"): ObservationAdmissionResult {
  const classification = ({ "invalid-reference": "invalid-reference", "snapshot-not-found": "not-found", "snapshot-mismatch": "mismatch", "snapshot-corrupt": "corrupt", "snapshot-store-error": "store" } as const)[kind];
  return failure(side === "current" ? "current-unresolved" : "prior-unresolved", classification, `${side === "current" ? "Current" : "Prior"} snapshot reference could not be admitted`);
}
function failure(kind: ObservationAdmissionErrorKind, classification: ObservationAdmissionError["classification"], message: string): ObservationAdmissionResult { return { ok: false, error: { kind, classification, message } }; }

function captureInvocation(input: AdmitProposalObservationInput): AdmitProposalObservationInput | null {
  try {
    if (!input || typeof input !== "object") return null;
    const image = structuredClone({ source: input.source, current: input.current, check: input.check, prior: input.prior });
    const snapshotStore = captureExactSnapshotReader(input.snapshotStore);
    return snapshotStore === null ? null : { ...image, snapshotStore };
  } catch { return null; }
}

export function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function bindCurrentSnapshot(finalUrl: string, redirects: readonly string[] | undefined, integrity: "snapshot-envelope" | "body-and-identity", registeredUrl: string): ObservationAdmissionResult | null {
  const binding = snapshotSourceBinding(registeredUrl, finalUrl, redirects, integrity, true);
  if (binding === "url-binding") return failure("insufficient-binding", "url-binding", "Snapshot URL is not bound to the registered source");
  if (binding === "redirect-binding") return failure("insufficient-binding", "redirect-binding", "Snapshot redirect capture is not admissibly bound");
  return null;
}

/** Forage records visited redirect URLs before the final URL. */
export function validRedirectChain(redirects: readonly string[], finalUrl: string): boolean {
  const urls = [...redirects, finalUrl].map(normalizedHttpUrl);
  if (urls.some((url) => url === null)) return false;
  const concrete = urls as string[];
  const parsed = concrete.map((url) => new URL(url));
  const host = parsed[0]!.host;
  for (let index = 0; index < parsed.length; index += 1) {
    const url = parsed[index]!;
    if (url.host !== host || (index > 0 && parsed[index - 1]!.protocol === "https:" && url.protocol !== "https:")) return false;
  }
  return true;
}
