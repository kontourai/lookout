import type { LookoutSource } from "./registry.js";
import { diffProposalSets, type ProposalDiffEvent, type ProposalSetDiff, type ProposalSetDiffInput, type ProposalSetFacts, type ProposalSetObservation } from "./proposal-diff.js";
import type { ObservationCheckAnchor, ObservationStore, StoredProposalObservationV1 } from "./observation-store.js";
import type { SnapshotStore } from "@kontourai/forage";
import { admitProposalObservation } from "./observation-admission.js";

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
    };
export interface DriftSuccess {
  readonly sourceId: string;
  readonly events: readonly ProposalDiffEvent[];
  readonly facts: readonly DriftFact[];
  /** The prior observation this drift was diffed against, or null on a first-ever (baseline) observation. */
  readonly priorObservationId: string | null;
  readonly committedObservation: StoredProposalObservationV1;
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
  readonly now?: () => string;
  readonly diff?: (input: ProposalSetDiffInput<E>) => { readonly ok: true; readonly value: ProposalSetDiff } | { readonly ok: false; readonly error: { readonly message: string } };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function normalizeDiff(value: ProposalSetDiff): ProposalSetDiff {
  const sorted = <T>(items: readonly T[]) => [...items].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
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
          facts = [{ kind: "baseline-established", sourceId: invocation.source.id, snapshotRef: invocation.current.snapshotRef, observedAt: invocation.current.observedAt, origin: invocation.source.kind, resolution: "observation", proposalCount: invocation.current.proposals.length }];
        } else {
          let derived;
          try {
            // Diff callbacks receive their own clone, never the image used for
            // durable commit below.
            derived = diff({ prior: { sourceId: prior.sourceId, snapshotRef: prior.snapshotRef, observedAt: prior.observedAt, proposals: capture(prior.proposals) ?? [] }, current: capture(invocation.current)!, ...invocation.callbacks });
          } catch (cause) {
            return { ok: false, error: { kind: "diff-error", message: "Proposal diff threw", cause } };
          }
          if (!derived.ok) return { ok: false, error: { kind: "diff-error", message: derived.error.message, cause: derived.error } };
          const normalized = normalizeDiff(derived.value);
          events = normalized.events;
          facts = [{ kind: "proposal-set-facts", priorSnapshotRef: prior.snapshotRef, currentSnapshotRef: invocation.current.snapshotRef, origin: invocation.source.kind, resolution: "observation", value: normalized.facts }];
        }

        try {
          JSON.stringify({ events, facts });
        } catch (cause) {
          return { ok: false, error: { kind: "serialization-error", message: "Drift result is not serializable", cause } };
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

function capture<T>(value: T): T | null { try { return structuredClone(value); } catch { return null; } }
function captureInvocation<E>(input: EmitDriftInput<E>): EmitDriftInput<E> | null {
  try {
    if (!input || typeof input !== "object") return null;
    const image = capture({ source: input.source, current: input.current, check: input.check });
    if (image === null || !input.callbacks || typeof input.callbacks !== "object") return null;
    return { ...image, callbacks: { ...input.callbacks } as EmitDriftInput<E>["callbacks"] };
  } catch { return null; }
}
