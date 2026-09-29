import type {
  ExtractionCoverageEntry,
  ExtractionPartial,
  ExtractionProposal,
  ExtractionProviderFailure,
  ExtractionResult,
  PreparedArtifact,
} from "@kontourai/traverse";
import { validatePreparedArtifact } from "@kontourai/traverse";
import { resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { SnapshotStore } from "@kontourai/forage/fetch";
import { captureDecoding } from "./capture-decoding.js";
import type { CheckResult } from "./check-result.js";
import type { ProposalSetIncompleteness, ProposalSetObservation } from "./proposal-diff.js";
import type { LookoutSource } from "./registry.js";

/** Acquisition is supplied by the caller; Lookout does not add another fetcher. */
export interface ObserveExtractAcquisition {
  check(source: LookoutSource): Promise<CheckResult>;
}

/**
 * Extraction is supplied by the caller. The input carries only immutable source
 * identity, leaving snapshot resolution, preparation, and provider selection
 * outside Lookout.
 */
export interface ObserveExtractExtraction {
  extract(input: ObserveExtractExtractionInput): Promise<ExtractionResult>;
}

export interface ObserveExtractExtractionInput {
  readonly source: LookoutSource;
  readonly snapshotRef: string;
}

export interface ObserveExtractAttempt {
  readonly extractedAt: string;
  readonly providerCalls: number;
  readonly totalTokensUsed: number;
  readonly partial?: ExtractionPartial;
  /** Traverse's per-chunk record of which prepared text was read and answered. */
  readonly coverage?: readonly ExtractionCoverageEntry[];
  readonly providerFailures?: readonly ObserveExtractProviderFailure[];
}

/** Provider-neutral durable classification; diagnostic payloads stay at the capability boundary. */
export interface ObserveExtractProviderFailure {
  readonly kind: ExtractionProviderFailure["kind"];
  readonly retryable: boolean;
}

export interface ObserveExtractSourceSnapshot {
  readonly priorSnapshotRef: string | null;
  readonly currentSnapshotRef: string;
}

export interface ObserveExtractSource {
  readonly id: string;
  readonly url: string;
  readonly kind: LookoutSource["kind"];
}

export type ObserveExtractOutcome =
  | "acquisition-error"
  | "unchanged"
  | "completed"
  | "partial"
  | "partial-provider-failure"
  | "provider-failure"
  | "extraction-failure";

/**
 * One source observation, ready for caller-owned durable recording. Raw
 * provider responses and source bodies are intentionally not copied here.
 */
export interface ObserveExtractObservation {
  readonly source: ObserveExtractSource;
  readonly check: CheckResult;
  readonly outcome: ObserveExtractOutcome;
  readonly sourceSnapshot: ObserveExtractSourceSnapshot | null;
  readonly preparedArtifact: PreparedArtifact | null;
  readonly proposalSet: ProposalSetObservation | null;
  readonly attempt: ObserveExtractAttempt | null;
}

export interface ObserveExtractObservationIdentity {
  readonly observationId: string;
  readonly priorObservationId: string | null;
}

/**
 * Lookout passes each completed observation to a caller-owned recorder. The
 * recorder controls durable storage and continuity while this composition never
 * supplies or configures the injected acquisition or extraction capabilities.
 */
export interface ObserveExtractRecorder {
  record(observation: ObserveExtractObservation): Promise<ObserveExtractObservationIdentity>;
  /**
   * The snapshot reference of this source's most recent recorded observation
   * for which `extractedSnapshotRef(observation)` is not null, or `null` when
   * there is none.
   *
   * An unchanged check is only skipped when its capture has the same URL, body
   * hash, and text decoding as this snapshot. Otherwise a change that acquisition already
   * persisted, but that was never extracted (for example because a provider
   * failed), would be reported as unchanged forever.
   */
  lastExtractedSnapshotRef(source: ObserveExtractSource): Promise<string | null>;
}

/**
 * The snapshot an observation's extraction fully handled: the current snapshot
 * of a `completed` or `unchanged` observation, or of a `partial` one whose
 * every loss would recur on the same capture, else `null`. Recorders use this
 * to answer `lastExtractedSnapshotRef`, so a capture whose loss could go
 * differently next time (an answer cut at the output cap, an unusable answer,
 * a token budget, a cancellation) is extracted again on the next check.
 */
export function extractedSnapshotRef(observation: ObserveExtractObservation): string | null {
  const handled = observation.outcome === "completed" || observation.outcome === "unchanged" ||
    (observation.outcome === "partial" && repeatableLoss(observation.attempt));
  return handled && observation.sourceSnapshot !== null ? observation.sourceSnapshot.currentSnapshotRef : null;
}

// Losses fixed by the capture and the extraction configuration: the content
// cap, the chunk cap, and the provider-call ceiling. Re-reading would lose the
// same text again and spend the budget for nothing.
const REPEATABLE_PARTIAL_REASONS: ReadonlySet<string> = new Set(["content-truncated", "max-chunks", "max-provider-calls"]);
function repeatableLoss(attempt: ObserveExtractAttempt | null): boolean {
  if (attempt?.partial === undefined || !REPEATABLE_PARTIAL_REASONS.has(attempt.partial.reason)) return false;
  // The partial reason names only the first loss; coverage has the rest.
  return (attempt.coverage ?? []).every((entry) => entry.status === "complete" ||
    (entry.status === "unread" && (entry.reason === "content-truncated" || entry.reason === "not-dispatched")));
}

export interface ObserveExtractDiffOptions {
  readonly acquisition: ObserveExtractAcquisition;
  readonly extraction: ObserveExtractExtraction;
  readonly recorder: ObserveExtractRecorder;
  /**
   * The snapshot store acquisition persists to. An unchanged check is compared
   * with the last extracted capture by resolving both references here, since a
   * reference does not name the charset its text was decoded with. A reference
   * that does not resolve counts as a different capture, so it is extracted.
   * With snapshot retention, cite the last extracted reference to keep it.
   */
  readonly snapshots: SnapshotStore;
}

export type ObserveExtractErrorKind = "acquisition-threw" | "recording-failed" | "dependency-contract";
export interface ObserveExtractError {
  readonly kind: ObserveExtractErrorKind;
  readonly message: string;
  readonly cause?: unknown;
}
export type ObserveExtractResult =
  | { readonly ok: true; readonly value: ObserveExtractObservation & ObserveExtractObservationIdentity }
  | { readonly ok: false; readonly error: ObserveExtractError; readonly observation?: ObserveExtractObservation };

export interface ObserveExtractDiff {
  observe(source: LookoutSource): Promise<ObserveExtractResult>;
}

export function createObserveExtractDiff(options: ObserveExtractDiffOptions): ObserveExtractDiff {
  // Without a store every unchanged capture would silently count as new and be
  // extracted again, so a missing one is refused up front.
  if (typeof options?.snapshots?.findExact !== "function") {
    throw new TypeError("createObserveExtractDiff requires snapshots: the snapshot store acquisition persists to, with exact lookup");
  }
  return {
    async observe(source): Promise<ObserveExtractResult> {
      try {
      let check: CheckResult;
      try {
        check = await options.acquisition.check(source);
      } catch (cause) {
        return { ok: false, error: error("acquisition-threw", "Acquisition capability threw", cause) };
      }

      if (!isCheckResult(check)) {
        return { ok: false, error: error("dependency-contract", "Acquisition capability returned an invalid check result") };
      }
      if (check.sourceId !== source.id || check.sourceUrl !== source.url) {
        return { ok: false, error: error("dependency-contract", "Acquisition result does not identify the requested source") };
      }

      if (check.kind === "error") {
        return record(options.recorder, baseObservation(source, check, "acquisition-error", null, null, null, null));
      }

      let sourceSnapshot = snapshotFor(check);
      if (check.kind === "unchanged-304" || check.kind === "unchanged-hash") {
        // "Unchanged" compares with the latest stored capture, which may never
        // have been extracted. Skip extraction only when the capture matches
        // the last one that was; otherwise extract it against that baseline.
        let extracted: unknown;
        try {
          extracted = await options.recorder.lastExtractedSnapshotRef(observationSource(source));
        } catch (cause) {
          return { ok: false, error: error("recording-failed", "Observation recorder could not report the last extracted snapshot", cause) };
        }
        if (extracted !== null && (typeof extracted !== "string" || extracted === "")) {
          return { ok: false, error: error("dependency-contract", "Observation recorder returned an invalid last extracted snapshot reference") };
        }
        if (extracted !== null && await sameCapture(options.snapshots, extracted, sourceSnapshot.currentSnapshotRef)) {
          return record(options.recorder, baseObservation(source, check, "unchanged", sourceSnapshot, null, null, null));
        }
        sourceSnapshot = { priorSnapshotRef: extracted, currentSnapshotRef: sourceSnapshot.currentSnapshotRef };
      }

      let extraction: ExtractionResult;
      try {
        extraction = await options.extraction.extract({ source, snapshotRef: sourceSnapshot.currentSnapshotRef });
      } catch {
        return record(options.recorder, baseObservation(
          source,
          check,
          "extraction-failure",
          sourceSnapshot,
          null,
          null,
          null,
        ));
      }

      if (!isExtractionResult(extraction)) {
        return { ok: false, error: error("dependency-contract", "Extraction capability returned an invalid extraction result") };
      }

      const attempt = attemptFor(extraction);
      const outcome = outcomeFor(extraction);
      const incomplete = incompletenessFor(extraction, outcome);
      const proposalSet: ProposalSetObservation = {
        sourceId: source.id,
        snapshotRef: sourceSnapshot.currentSnapshotRef,
        observedAt: extraction.extractedAt,
        proposals: extraction.proposals,
        ...(incomplete === null ? {} : { incomplete }),
      };
      if (outcome !== "extraction-failure") {
        if (extraction.preparedArtifact === undefined) {
          return { ok: false, error: error("dependency-contract", "Extraction result is missing its prepared artifact") };
        }
      }
      if (extraction.preparedArtifact !== undefined) {
        const validation = validatePreparedArtifact(extraction.preparedArtifact);
        if (validation.status !== "valid") {
          return { ok: false, error: error("dependency-contract", `Extraction result has an invalid prepared artifact: ${validation.status}`) };
        }
        if (validation.artifact.sourceSnapshotRef !== sourceSnapshot.currentSnapshotRef) {
          return { ok: false, error: error("dependency-contract", "Prepared artifact does not identify the current source snapshot") };
        }
      }
      return record(options.recorder, baseObservation(
        source,
        check,
        outcome,
        sourceSnapshot,
        extraction.preparedArtifact ?? null,
        proposalSet,
        attempt,
      ));
      } catch (cause) {
        return { ok: false, error: error("dependency-contract", "Observe-extract composition could not inspect a capability result", cause) };
      }
    },
  };
}

function baseObservation(
  source: LookoutSource,
  check: CheckResult,
  outcome: ObserveExtractOutcome,
  sourceSnapshot: ObserveExtractSourceSnapshot | null,
  preparedArtifact: PreparedArtifact | null,
  proposalSet: ProposalSetObservation | null,
  attempt: ObserveExtractAttempt | null,
): ObserveExtractObservation {
  return {
    source: observationSource(source),
    check,
    outcome,
    sourceSnapshot,
    preparedArtifact,
    proposalSet,
    attempt,
  };
}

async function record(recorder: ObserveExtractRecorder, observation: ObserveExtractObservation): Promise<ObserveExtractResult> {
  try {
    const identity = await recorder.record(observation);
    if (!isIdentity(identity)) {
      return { ok: false, error: error("dependency-contract", "Observation recorder returned an invalid identity"), observation };
    }
    return {
      ok: true,
      value: {
        ...observation,
        observationId: identity.observationId,
        priorObservationId: identity.priorObservationId,
      },
    };
  } catch (cause) {
    return { ok: false, error: error("recording-failed", "Observation recorder failed", cause), observation };
  }
}

function observationSource(source: LookoutSource): ObserveExtractSource {
  return { id: source.id, url: source.url, kind: source.kind };
}

/**
 * Two references name the same capture content: same source, resource URL,
 * body hash, and text decoding. Same bytes under another declared charset are
 * other text, so they are a different capture.
 */
async function sameCapture(store: SnapshotStore, left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  const [a, b] = await Promise.all([resolveSnapshotSourceRef(store, left), resolveSnapshotSourceRef(store, right)]);
  if (!a.ok || !b.ok) return false;
  return a.snapshot.sourceId === b.snapshot.sourceId && a.snapshot.url === b.snapshot.url &&
    a.snapshot.bodyHash === b.snapshot.bodyHash && captureDecoding(a.snapshot) === captureDecoding(b.snapshot);
}

function snapshotFor(check: Exclude<CheckResult, { kind: "error" }>): ObserveExtractSourceSnapshot {
  if (check.kind === "unchanged-304") return { priorSnapshotRef: check.snapshotRef, currentSnapshotRef: check.snapshotRef };
  return { priorSnapshotRef: check.priorSnapshotRef, currentSnapshotRef: check.currentSnapshotRef };
}

function attemptFor(result: ExtractionResult): ObserveExtractAttempt {
  return {
    extractedAt: result.extractedAt,
    providerCalls: result.providerCalls,
    totalTokensUsed: result.totalTokensUsed,
    ...(result.partial === undefined ? {} : { partial: result.partial }),
    ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
    ...(result.providerFailures === undefined ? {} : {
      providerFailures: result.providerFailures.map(({ kind, retryable }) => ({ kind, retryable })),
    }),
  };
}

/**
 * Every outcome other than `completed` read less than all of its text, or
 * failed, so its proposal set must not be diffed as if it were whole.
 */
function incompletenessFor(result: ExtractionResult, outcome: ObserveExtractOutcome): ProposalSetIncompleteness | null {
  if (outcome === "completed") return null;
  return {
    reason: result.partial?.reason ?? (result.providerFailures?.length ? "provider-failure" : "extraction-error"),
    ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
  };
}

function outcomeFor(result: ExtractionResult): Extract<ObserveExtractOutcome, "completed" | "partial" | "partial-provider-failure" | "provider-failure" | "extraction-failure"> {
  const hasProviderFailures = (result.providerFailures?.length ?? 0) > 0;
  if (result.partial !== undefined && hasProviderFailures) return "partial-provider-failure";
  if (hasProviderFailures) return "provider-failure";
  if (result.error !== undefined) return "extraction-failure";
  return result.partial === undefined ? "completed" : "partial";
}

function isCheckResult(value: unknown): value is CheckResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.sourceId !== "string" || typeof result.sourceUrl !== "string" ||
      typeof result.checkedAt !== "string" || !Array.isArray(result.warnings)) return false;
  if (result.kind === "unchanged-304") return typeof result.snapshotRef === "string";
  if (result.kind === "unchanged-hash") return typeof result.priorSnapshotRef === "string" && typeof result.currentSnapshotRef === "string";
  if (result.kind === "changed") return (result.priorSnapshotRef === null || typeof result.priorSnapshotRef === "string") &&
    typeof result.currentSnapshotRef === "string" && (result.changeBasis === "initial" || result.changeBasis === "hash");
  return result.kind === "error" && (result.origin === "forage" || result.origin === "lookout") && result.error !== undefined;
}

function isExtractionResult(value: unknown): value is ExtractionResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<ExtractionResult>;
  return Array.isArray(result.proposals) && typeof result.extractedAt === "string" &&
    Number.isFinite(result.providerCalls) && Number.isFinite(result.totalTokensUsed);
}

function isIdentity(value: unknown): value is ObserveExtractObservationIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<ObserveExtractObservationIdentity>;
  return typeof identity.observationId === "string" && identity.observationId !== "" &&
    (identity.priorObservationId === null || (typeof identity.priorObservationId === "string" && identity.priorObservationId !== ""));
}

function error(kind: ObserveExtractErrorKind, text: string, cause?: unknown): ObserveExtractError {
  return { kind, message: text, ...(cause === undefined ? {} : { cause }) };
}
