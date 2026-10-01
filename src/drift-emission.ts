import type { LookoutSource } from "./registry.js";
import { diffProposalSets, type ProposalDiffEvent, type ProposalSetDiff, type ProposalSetDiffInput, type ProposalSetFacts, type ProposalSetIncompleteness, type ProposalSetObservation } from "./proposal-diff.js";
import type { ObservationCheckAnchor, ObservationStore, StoredProposalObservation } from "./observation-store.js";
import type { Snapshot, SnapshotStore } from "@kontourai/forage";
import { resolvePreparedArtifact, type PreparedArtifact } from "@kontourai/traverse";
import { resolveLookoutSnapshot } from "./snapshot-store.js";
import { compareCodeUnits } from "./canonical-json.js";
import { admitProposalObservation } from "./observation-admission.js";
import { lossRecurs } from "./incompleteness.js";

// Neutral drift emission. Lookout is a CHANGE building block: it detects and
// reports drift in its own vocabulary and depends on NOTHING in the trust layer
// (neither the `@kontourai/surface` foundation nor any product). Its output is
// trust-format-AWARE in SHAPE — every ProposalEvidence already carries
// snapshotRef / locator / excerpt / extractor / fieldPath, i.e. it maps
// one-to-one onto a Hachure evidence record — but trust-format-INDEPENDENT in
// dependencies. A consumer (or a product like survey) lifts these events into a
// Hachure/surface TrustBundle with surface's TrustBundleBuilder; lookout never
// authors that record itself. This mirrors traverse, whose proposals match
// Survey's shape without importing survey.

export interface BaselineEstablishedFact {
  readonly kind: "baseline-established";
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly origin: LookoutSource["kind"];
  readonly resolution: "observation";
  readonly proposalCount: number;
  /** Present when this baseline's extraction did not read all of its text. */
  readonly incomplete?: ProposalSetIncompleteness;
}
export type DriftFact =
  | BaselineEstablishedFact
  | {
      readonly kind: "proposal-set-facts";
      readonly priorSnapshotRef: string;
      readonly currentSnapshotRef: string;
      readonly origin: LookoutSource["kind"];
      readonly resolution: "observation";
      readonly value: ProposalSetFacts;
      /** Present when the current extraction did not read all of its text; nothing the prior had is then reported as removed. */
      readonly incomplete?: ProposalSetIncompleteness;
      /**
       * Present when the prior baseline's extraction did not read all of its
       * text. What the current run has that the prior lacks is then newly
       * observed, not added, unless `priorText` is `verified` and an entity's
       * text occurs nowhere in the prior's capture.
       */
      readonly priorIncomplete?: ProposalSetIncompleteness;
      /** Present with `priorIncomplete`: whether the prior's prepared text could be rebuilt to anchor new entities against. */
      readonly priorText?: PriorTextStatus;
    };

/**
 * Whether an incomplete prior's full prepared text was rebuilt and verified.
 * When it was not, every entity the prior lacks stays newly observed and
 * `reason` says why.
 */
export type PriorTextStatus =
  | { readonly status: "verified" }
  /** Nothing the prior lacked needed anchoring, so the prior's text was not read. */
  | { readonly status: "not-needed" }
  | { readonly status: "unavailable"; readonly reason: PriorTextUnavailableReason };
export type PriorTextUnavailableReason =
  /** The emitter was created without `priorText`. */
  | "not-configured"
  /** The prior or current observation carries no prepared artifact. */
  | "no-prepared-artifact"
  /** Prior and current text were prepared by a different mode or version, so excerpts are not comparable. */
  | "preparation-changed"
  /** The prior's text or capture is larger than `priorText.maxChars`. */
  | "too-large"
  /** The prior's snapshot no longer resolves in the snapshot store. */
  | "snapshot-unresolved"
  /** The caller's preparation threw or returned something other than text. */
  | "preparation-failed"
  /** The caller's preparation did not settle within `priorText.timeoutMs`. */
  | "preparation-timeout"
  /** The rebuilt text does not match the prior's prepared-artifact digest. */
  | "text-mismatch";

/**
 * Rebuilds a stored capture's prepared text so new entities can be anchored
 * against an incomplete prior. Lookout reads the prior's snapshot from the
 * snapshot store; the caller prepares it exactly as its extraction did. No
 * provider is called.
 */
export interface PriorTextPreparation {
  prepare(input: { readonly snapshot: Snapshot; readonly preparedArtifact: PreparedArtifact }): string | Promise<string>;
  /**
   * Largest prior prepared text and snapshot body, in UTF-16 code units or
   * bytes, that is prepared. Larger ones are `too-large`. Default 4,000,000.
   * The prepared-text length is checked before any read; the body length only
   * after the snapshot store has returned the whole body, because a snapshot
   * store cannot report a size first (the emitter's snapshot admission reads
   * the same body anyway). It bounds preparation, not that read.
   */
  readonly maxChars?: number;
  /**
   * How long `prepare` may take, in milliseconds, before the rebuild is
   * abandoned as `preparation-timeout`. Default 30,000. The call itself is
   * not cancelled; its eventual result is ignored.
   */
  readonly timeoutMs?: number;
}
export interface DriftSuccess {
  readonly sourceId: string;
  readonly events: readonly ProposalDiffEvent[];
  readonly facts: readonly DriftFact[];
  /** The prior observation this drift was diffed against, or null on a first-ever (baseline) observation. */
  readonly priorObservationId: string | null;
  /**
   * The observation now stored as the source's baseline, or null when this run
   * lost text in a way that might not recur (an output cap, an unusable answer,
   * a provider failure, a token budget, a cancellation) and a baseline already
   * existed. Such a run never replaces a baseline, so the next run is diffed
   * against the prior. A run whose every loss recurs on the same capture (the
   * content cap, the chunk cap, the provider-call ceiling) is stored with its
   * `incomplete` marker.
   */
  readonly committedObservation: StoredProposalObservation | null;
  readonly warnings: readonly string[];
}
export type DriftErrorKind = "invalid-input" | "prior-state-error" | "diff-error" | "persistence-error" | "serialization-error" | "unexpected";
export interface DriftError {
  readonly kind: DriftErrorKind;
  readonly message: string;
  readonly cause?: unknown;
}
export type DriftResult = { readonly ok: true; readonly value: DriftSuccess } | { readonly ok: false; readonly error: DriftError };

export interface EmitDriftInput<E> {
  readonly source: LookoutSource;
  readonly current: ProposalSetObservation;
  readonly check: ObservationCheckAnchor;
  readonly callbacks: Omit<ProposalSetDiffInput<E>, "prior" | "current">;
}
export interface DriftEmitter<E> {
  emit(input: EmitDriftInput<E>): Promise<DriftResult>;
}
export interface CreateDriftEmitterOptions<E> {
  readonly store: ObservationStore;
  /** Required explicit capability for authenticating durable snapshot references. */
  readonly snapshotStore: SnapshotStore;
  /**
   * Optional: rebuild an incomplete prior's prepared text so an entity whose
   * text was nowhere in the prior's capture raises `new-entity-appeared`
   * instead of staying newly observed. Without it, a page that stays capped
   * never reports added entities after its first capped run.
   */
  readonly priorText?: PriorTextPreparation;
  readonly now?: () => string;
  readonly diff?: (input: ProposalSetDiffInput<E>) => { readonly ok: true; readonly value: ProposalSetDiff } | { readonly ok: false; readonly error: { readonly message: string } };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function normalizeDiff(value: ProposalSetDiff): ProposalSetDiff {
  const sorted = <T>(items: readonly T[]) => [...items].sort((a, b) => compareCodeUnits(stableJson(a), stableJson(b)));
  return {
    events: sorted(value.events),
    facts: {
      retainedProposalOccurrences: sorted(value.facts.retainedProposalOccurrences),
      addedProposalOccurrences: sorted(value.facts.addedProposalOccurrences),
      removedProposalOccurrences: sorted(value.facts.removedProposalOccurrences),
      provenanceChanges: sorted(value.facts.provenanceChanges),
      removedEntities: [...value.facts.removedEntities].sort(),
      addedProposalEvidence: sorted(value.facts.addedProposalEvidence ?? []),
      removedProposalEvidence: sorted(value.facts.removedProposalEvidence ?? []),
      confidenceChanges: sorted(value.facts.confidenceChanges ?? []),
      ...(value.facts.excerptBoundaryChanges === undefined ? {} : { excerptBoundaryChanges: sorted(value.facts.excerptBoundaryChanges) }),
      ...(value.facts.newlyObservedProposalOccurrences === undefined ? {} : { newlyObservedProposalOccurrences: sorted(value.facts.newlyObservedProposalOccurrences) }),
      ...(value.facts.newlyObservedProposalEvidence === undefined ? {} : { newlyObservedProposalEvidence: sorted(value.facts.newlyObservedProposalEvidence) }),
      ...(value.facts.newlyObservedEntities === undefined ? {} : { newlyObservedEntities: [...value.facts.newlyObservedEntities].sort() }),
      ...(value.facts.newlyObservedEntityAnchors === undefined ? {} : { newlyObservedEntityAnchors: sorted(value.facts.newlyObservedEntityAnchors) }),
      ...(value.facts.unobservedProposalOccurrences === undefined ? {} : { unobservedProposalOccurrences: sorted(value.facts.unobservedProposalOccurrences) }),
      ...(value.facts.unobservedProposalEvidence === undefined ? {} : { unobservedProposalEvidence: sorted(value.facts.unobservedProposalEvidence) }),
      ...(value.facts.unobservedEntities === undefined ? {} : { unobservedEntities: [...value.facts.unobservedEntities].sort() }),
    },
  };
}

export function createDriftEmitter<E>(options: CreateDriftEmitterOptions<E>): DriftEmitter<E> {
  const now = options.now ?? (() => new Date().toISOString());
  const diff = options.diff ?? diffProposalSets;
  return {
    async emit(input): Promise<DriftResult> {
      try {
        // Copy the complete caller image before the first await. Callers retain
        // their objects, so resolving a snapshot must not create a time window
        // in which a mutated ref/proposal is later committed under an admitted one.
        const invocation = captureInvocation(input);
        if (!invocation || !invocation.source || invocation.source.id !== invocation.current?.sourceId || invocation.check?.currentSnapshotRef !== invocation.current?.snapshotRef) {
          return { ok: false, error: { kind: "invalid-input", message: "Registry source, observation, and check anchor must agree" } };
        }
        // Admit the current reference before continuity I/O.  In particular,
        // Forage rejects a malformed digest before findExact/loadLatest runs.
        const currentAdmission = await admitProposalObservation({ source: invocation.source, current: invocation.current, check: invocation.check, prior: null, snapshotStore: options.snapshotStore });
        if (!currentAdmission.ok) return { ok: false, error: { kind: "invalid-input", message: "Current observation could not be admitted" } };
        const loaded = await options.store.loadLatest(invocation.source.id);
        if (!loaded.ok) return { ok: false, error: { kind: "prior-state-error", message: loaded.error.message, cause: loaded.error } };
        const prior = loaded.value === null ? null : capture(loaded.value);
        if (loaded.value !== null && prior === null) return { ok: false, error: { kind: "prior-state-error", message: "Prior observation could not be captured" } };
        const admission = await admitProposalObservation({ source: invocation.source, current: invocation.current, check: invocation.check, prior, snapshotStore: options.snapshotStore });
        if (!admission.ok) return { ok: false, error: { kind: admission.error.kind === "prior-unresolved" ? "prior-state-error" : "invalid-input", message: "Observation could not be admitted" } };

        const recordedAt = now();
        const priorObservationId = prior?.observationId ?? null;
        let events: readonly ProposalDiffEvent[] = [];
        let facts: readonly DriftFact[];

        if (prior === null) {
          facts = [{ kind: "baseline-established", sourceId: invocation.source.id, snapshotRef: invocation.current.snapshotRef, observedAt: invocation.current.observedAt, origin: invocation.source.kind, resolution: "observation", proposalCount: invocation.current.proposals.length, ...incompleteness(invocation.current) }];
        } else {
          let derived;
          let priorText: PriorTextStatus | undefined;
          try {
            // Diff callbacks receive their own clone, never the image used for
            // durable commit below.
            const priorImage = { sourceId: prior.sourceId, snapshotRef: prior.snapshotRef, observedAt: prior.observedAt, ...incompleteness(prior) };
            derived = diff({ prior: { ...priorImage, proposals: capture(prior.proposals) ?? [] }, current: capture(invocation.current)!, ...invocation.callbacks });
            if (prior.incomplete !== undefined && derived.ok) {
              // The prior's text is only rebuilt when there is a new entity to
              // anchor; a capped page with nothing new costs no snapshot read.
              if ((derived.value.facts.newlyObservedEntities ?? []).length === 0) priorText = { status: "not-needed" };
              else {
                const anchored = await rebuildPriorText(prior, invocation.current, options);
                if ("text" in anchored) {
                  priorText = { status: "verified" };
                  derived = diff({ prior: { ...priorImage, proposals: capture(prior.proposals) ?? [] }, current: capture(invocation.current)!, ...invocation.callbacks, priorPreparedText: anchored.text });
                } else priorText = { status: "unavailable", reason: anchored.reason };
              }
            }
          } catch (cause) {
            return { ok: false, error: { kind: "diff-error", message: "Proposal diff threw", cause } };
          }
          if (!derived.ok) return { ok: false, error: { kind: "diff-error", message: derived.error.message, cause: derived.error } };
          const normalized = normalizeDiff(derived.value);
          events = normalized.events;
          facts = [{ kind: "proposal-set-facts", priorSnapshotRef: prior.snapshotRef, currentSnapshotRef: invocation.current.snapshotRef, origin: invocation.source.kind, resolution: "observation", value: normalized.facts, ...incompleteness(invocation.current), ...(prior.incomplete === undefined ? {} : { priorIncomplete: prior.incomplete }), ...(priorText === undefined ? {} : { priorText }) }];
        }

        try {
          JSON.stringify({ events, facts });
        } catch (cause) {
          return { ok: false, error: { kind: "serialization-error", message: "Drift result is not serializable", cause } };
        }

        // A loss that could go differently next time never replaces a
        // baseline. A loss that recurs on every capture (a cap) does, with its
        // marker; otherwise a capped page would re-diff against the same old
        // baseline and repeat the same events on every capture.
        if (prior !== null && invocation.current.incomplete !== undefined && !lossRecurs(invocation.current.incomplete)) {
          return { ok: true, value: { sourceId: invocation.source.id, events, facts, priorObservationId, committedObservation: null, warnings: [] } };
        }
        const committed = await options.store.commit({ observation: invocation.current, recordedAt, check: invocation.check }, prior?.observationId ?? null);
        if (!committed.ok) return { ok: false, error: { kind: "persistence-error", message: committed.error.message, cause: committed.error } };
        return { ok: true, value: { sourceId: invocation.source.id, events, facts, priorObservationId, committedObservation: committed.value, warnings: committed.warnings ?? [] } };
      } catch (cause) {
        return { ok: false, error: { kind: "unexpected", message: "Drift emission failed", cause } };
      }
    },
  };
}

const DEFAULT_PRIOR_TEXT_MAX_CHARS = 4_000_000;
const DEFAULT_PRIOR_TEXT_TIMEOUT_MS = 30_000;

/**
 * The incomplete prior's full prepared text, re-prepared from its snapshot and
 * verified against its prepared-artifact digest, or why it is unavailable.
 * Sizes are checked before the body is handed to preparation.
 */
async function rebuildPriorText<E>(prior: StoredProposalObservation, current: ProposalSetObservation, options: CreateDriftEmitterOptions<E>): Promise<{ readonly text: string } | { readonly reason: PriorTextUnavailableReason }> {
  const preparation = options.priorText;
  if (preparation === undefined) return { reason: "not-configured" };
  const artifact = prior.preparedArtifact;
  if (artifact === undefined || current.preparedArtifact === undefined) return { reason: "no-prepared-artifact" };
  if (artifact.preparationMode !== current.preparedArtifact.preparationMode || artifact.preparationVersion !== current.preparedArtifact.preparationVersion) return { reason: "preparation-changed" };
  const max = preparation.maxChars ?? DEFAULT_PRIOR_TEXT_MAX_CHARS;
  if (artifact.contentLength > max) return { reason: "too-large" };
  const resolved = await resolveLookoutSnapshot(prior.snapshotRef, { store: options.snapshotStore });
  if (!resolved.ok) return { reason: "snapshot-unresolved" };
  if (resolved.snapshot.body.length > max) return { reason: "too-large" };
  let text: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timed-out");
  try {
    const expiry = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), preparation.timeoutMs ?? DEFAULT_PRIOR_TEXT_TIMEOUT_MS); });
    text = await Promise.race([Promise.resolve().then(() => preparation.prepare({ snapshot: resolved.snapshot, preparedArtifact: structuredClone(artifact) })), expiry]);
  } catch { return { reason: "preparation-failed" }; }
  finally { clearTimeout(timer); }
  if (text === timedOut) return { reason: "preparation-timeout" };
  if (typeof text !== "string") return { reason: "preparation-failed" };
  const verified = await resolvePreparedArtifact(artifact, { get: () => text as string });
  return verified.status === "available" ? { text: verified.text } : { reason: "text-mismatch" };
}

function incompleteness(observation: { readonly incomplete?: ProposalSetIncompleteness }): { readonly incomplete?: ProposalSetIncompleteness } {
  return observation.incomplete === undefined ? {} : { incomplete: observation.incomplete };
}
function capture<T>(value: T): T | null { try { return structuredClone(value); } catch { return null; } }
function captureInvocation<E>(input: EmitDriftInput<E>): EmitDriftInput<E> | null {
  try {
    if (!input || typeof input !== "object") return null;
    const image = capture({ source: input.source, current: input.current, check: input.check });
    if (image === null || !input.callbacks || typeof input.callbacks !== "object") return null;
    return { ...image, callbacks: { ...input.callbacks } as EmitDriftInput<E>["callbacks"] };
  } catch { return null; }
}
