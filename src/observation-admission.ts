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
  try { return await admit(input); }
  catch { return failure("invalid-input", "source-identity", "Observation admission input is malformed"); }
}

async function admit(input: AdmitProposalObservationInput): Promise<ObservationAdmissionResult> {
  if (!input || typeof input !== "object" || !input.source || typeof input.source !== "object" || !input.current || typeof input.current !== "object" || !input.check || typeof input.check !== "object" || !input.snapshotStore || typeof input.snapshotStore !== "object" ||
    typeof input.source.id !== "string" || typeof input.source.url !== "string" || typeof input.current.sourceId !== "string" || typeof input.current.snapshotRef !== "string" || typeof input.check.currentSnapshotRef !== "string" ||
    input.source.id !== input.current.sourceId || input.check.currentSnapshotRef !== input.current.snapshotRef) {
    return failure("invalid-input", "source-identity", "Registry source, observation, and check anchor must agree");
  }
  const registeredUrl = normalizedHttpUrl(input.source.url);
  if (registeredUrl === null) return failure("invalid-input", "url-binding", "Registered source URL is not an admissible HTTP URL");

  // resolveLookoutSnapshot delegates canonical reference validation to Forage;
  // its resolver validates before calling findExact, so malformed refs perform
  // no snapshot-store I/O.
  const current = await resolveLookoutSnapshot(input.current.snapshotRef, { store: input.snapshotStore });
  if (!current.ok) return resolutionFailure("current", current.error.kind);
  if (current.snapshot.sourceId !== input.source.id) return failure("invalid-input", "source-identity", "Current snapshot identity does not match the registered source");
  const currentBinding = bindCurrentSnapshot(current.snapshot.url, current.snapshot.redirects, current.integrity, registeredUrl);
  if (currentBinding !== null) return currentBinding;

  if (input.prior === null) return { ok: true, value: { current: identity(input.current.snapshotRef, current), prior: null } };
  if (!input.prior || typeof input.prior !== "object" || typeof input.prior.sourceId !== "string" || typeof input.prior.snapshotRef !== "string" || !input.prior.check || typeof input.prior.check !== "object" || typeof input.prior.check.currentSnapshotRef !== "string" ||
    input.prior.sourceId !== input.source.id || input.prior.check.currentSnapshotRef !== input.prior.snapshotRef) {
    return failure("invalid-input", "source-identity", "Prior observation identity is not valid for the registered source");
  }
  const prior = await resolveLookoutSnapshot(input.prior.snapshotRef, { store: input.snapshotStore });
  if (!prior.ok) return resolutionFailure("prior", prior.error.kind);
  if (prior.snapshot.sourceId !== input.source.id) return failure("invalid-input", "source-identity", "Prior snapshot identity does not match the registered source");
  // A historical capture may legitimately precede a registry URL change. It
  // still needs durable identity authentication, but is not rebound to today’s URL.
  if (prior.snapshot.redirects?.length && prior.integrity !== "snapshot-envelope") {
    return failure("insufficient-binding", "redirect-binding", "Legacy snapshot references cannot authenticate redirect captures");
  }
  if (prior.snapshot.redirects?.length && !validRedirectChain(prior.snapshot.redirects, prior.snapshot.url)) {
    return failure("insufficient-binding", "redirect-binding", "Snapshot redirect capture is not admissibly bound");
  }
  return { ok: true, value: { current: identity(input.current.snapshotRef, current), prior: identity(input.prior.snapshotRef, prior) } };
}

function identity(snapshotRef: string, resolved: Extract<Awaited<ReturnType<typeof resolveLookoutSnapshot>>, { ok: true }>): AdmittedSnapshotIdentity {
  return { sourceId: resolved.snapshot.sourceId, snapshotRef, url: resolved.snapshot.url, bodyHash: resolved.snapshot.bodyHash, fetchedAt: resolved.snapshot.fetchedAt, ...(resolved.reference.snapshotDigest === undefined ? {} : { snapshotDigest: resolved.reference.snapshotDigest }), integrity: resolved.integrity };
}
function resolutionFailure(side: "current" | "prior", kind: "invalid-reference" | "snapshot-not-found" | "snapshot-mismatch" | "snapshot-corrupt" | "snapshot-store-error"): ObservationAdmissionResult {
  const classification = ({ "invalid-reference": "invalid-reference", "snapshot-not-found": "not-found", "snapshot-mismatch": "mismatch", "snapshot-corrupt": "corrupt", "snapshot-store-error": "store" } as const)[kind];
  return failure(side === "current" ? "current-unresolved" : "prior-unresolved", classification, `${side === "current" ? "Current" : "Prior"} snapshot reference could not be admitted`);
}
function failure(kind: ObservationAdmissionErrorKind, classification: ObservationAdmissionError["classification"], message: string): ObservationAdmissionResult { return { ok: false, error: { kind, classification, message } }; }

function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function bindCurrentSnapshot(finalUrl: string, redirects: readonly string[] | undefined, integrity: "snapshot-envelope" | "body-and-identity", registeredUrl: string): ObservationAdmissionResult | null {
  const normalizedFinal = normalizedHttpUrl(finalUrl);
  if (normalizedFinal === null) return failure("insufficient-binding", "url-binding", "Snapshot URL is not an admissible HTTP URL");
  if (!redirects?.length) return normalizedFinal === registeredUrl ? null : failure("insufficient-binding", "url-binding", "Snapshot URL is not bound to the registered source");
  if (integrity !== "snapshot-envelope") return failure("insufficient-binding", "redirect-binding", "Legacy snapshot references cannot authenticate redirect captures");
  if (normalizedHttpUrl(redirects[0]!) !== registeredUrl || !validRedirectChain(redirects, finalUrl)) return failure("insufficient-binding", "redirect-binding", "Snapshot redirect capture is not admissibly bound");
  return null;
}

/** Forage records visited redirect URLs before the final URL. */
function validRedirectChain(redirects: readonly string[], finalUrl: string): boolean {
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
