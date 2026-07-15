import type { LookoutSource } from "./registry.js";
import { diffProposalSets, type ProposalDiffEvent, type ProposalSetDiff, type ProposalSetDiffInput, type ProposalSetFacts, type ProposalSetObservation } from "./proposal-diff.js";
import type { ObservationCheckAnchor, ObservationStore, StoredProposalObservationV1 } from "./observation-store.js";

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
    },
  };
}

export function createDriftEmitter<E>(options: CreateDriftEmitterOptions<E>): DriftEmitter<E> {
  const now = options.now ?? (() => new Date().toISOString());
  const diff = options.diff ?? diffProposalSets;
  return {
    async emit(input): Promise<DriftResult> {
      try {
        if (!input.source || input.source.id !== input.current?.sourceId || input.check?.currentSnapshotRef !== input.current?.snapshotRef) {
          return { ok: false, error: { kind: "invalid-input", message: "Registry source, observation, and check anchor must agree" } };
        }
        const loaded = await options.store.loadLatest(input.source.id);
        if (!loaded.ok) return { ok: false, error: { kind: "prior-state-error", message: loaded.error.message, cause: loaded.error } };

        const recordedAt = now();
        const priorObservationId = loaded.value?.observationId ?? null;
        let events: readonly ProposalDiffEvent[] = [];
        let facts: readonly DriftFact[];

        if (loaded.value === null) {
          facts = [{ kind: "baseline-established", sourceId: input.source.id, snapshotRef: input.current.snapshotRef, observedAt: input.current.observedAt, origin: input.source.kind, resolution: "observation", proposalCount: input.current.proposals.length }];
        } else {
          let derived;
          try {
            derived = diff({ prior: { sourceId: loaded.value.sourceId, snapshotRef: loaded.value.snapshotRef, observedAt: loaded.value.observedAt, proposals: loaded.value.proposals }, current: input.current, ...input.callbacks });
          } catch (cause) {
            return { ok: false, error: { kind: "diff-error", message: "Proposal diff threw", cause } };
          }
          if (!derived.ok) return { ok: false, error: { kind: "diff-error", message: derived.error.message, cause: derived.error } };
          const normalized = normalizeDiff(derived.value);
          events = normalized.events;
          facts = [{ kind: "proposal-set-facts", priorSnapshotRef: loaded.value.snapshotRef, currentSnapshotRef: input.current.snapshotRef, origin: input.source.kind, resolution: "observation", value: normalized.facts }];
        }

        try {
          JSON.stringify({ events, facts });
        } catch (cause) {
          return { ok: false, error: { kind: "serialization-error", message: "Drift result is not serializable", cause } };
        }

        const committed = await options.store.commit({ observation: input.current, recordedAt, check: input.check }, loaded.value?.observationId ?? null);
        if (!committed.ok) return { ok: false, error: { kind: "persistence-error", message: committed.error.message, cause: committed.error } };
        return { ok: true, value: { sourceId: input.source.id, events, facts, priorObservationId, committedObservation: committed.value, warnings: committed.warnings ?? [] } };
      } catch (cause) {
        return { ok: false, error: { kind: "unexpected", message: "Drift emission failed", cause } };
      }
    },
  };
}
