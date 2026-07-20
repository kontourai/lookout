import type {
  ExtractionPartial,
  ExtractionProposal,
  ExtractionProviderFailure,
  ExtractionResult,
  PreparedArtifact,
} from "@kontourai/traverse";
import { validatePreparedArtifact } from "@kontourai/traverse";
import type { CheckResult } from "./check-result.js";
import type { ProposalSetObservation } from "./proposal-diff.js";
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
}

export interface ObserveExtractDiffOptions {
  readonly acquisition: ObserveExtractAcquisition;
  readonly extraction: ObserveExtractExtraction;
  readonly recorder: ObserveExtractRecorder;
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

      if (check.kind === "unchanged-304" || check.kind === "unchanged-hash") {
        return record(options.recorder, baseObservation(source, check, "unchanged", snapshotFor(check), null, null, null));
      }

      const sourceSnapshot = snapshotFor(check);
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
      const proposalSet: ProposalSetObservation = {
        sourceId: source.id,
        snapshotRef: sourceSnapshot.currentSnapshotRef,
        observedAt: extraction.extractedAt,
        proposals: extraction.proposals,
      };
      const outcome = outcomeFor(extraction);
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
    source: { id: source.id, url: source.url, kind: source.kind },
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
    ...(result.providerFailures === undefined ? {} : {
      providerFailures: result.providerFailures.map(({ kind, retryable }) => ({ kind, retryable })),
    }),
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
