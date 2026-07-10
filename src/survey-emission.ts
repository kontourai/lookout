import { createHash } from "node:crypto";
import { SurveyInputBuilder, type ProvenanceResolution, type SurveyInput, type SurveyObservationInput } from "@kontourai/survey";
import type { LookoutSource } from "./registry.js";
import { diffProposalSets, type ProposalDiffEvent, type ProposalSetDiff, type ProposalSetDiffInput, type ProposalSetFacts, type ProposalSetObservation } from "./proposal-diff.js";
import type { ObservationCheckAnchor, ObservationStore, StoredProposalObservationV1 } from "./observation-store.js";

export interface BaselineEstablishedFact { readonly kind: "baseline-established"; readonly sourceId: string; readonly snapshotRef: string; readonly observedAt: string; readonly origin: LookoutSource["kind"]; readonly resolution: "observation"; readonly proposalCount: number }
export type EmissionFact = BaselineEstablishedFact | { readonly kind: "proposal-set-facts"; readonly priorSnapshotRef: string; readonly currentSnapshotRef: string; readonly origin: LookoutSource["kind"]; readonly resolution: "observation"; readonly value: ProposalSetFacts };
export interface EmissionSuccess { readonly sourceId: string; readonly events: readonly ProposalDiffEvent[]; readonly facts: readonly EmissionFact[]; readonly surveyInput: SurveyInput | null; readonly committedObservation: StoredProposalObservationV1; readonly warnings: readonly string[] }
export type EmissionErrorKind = "invalid-input" | "prior-state-error" | "diff-error" | "authoring-error" | "persistence-error";
export interface EmissionError { readonly kind: EmissionErrorKind; readonly message: string; readonly cause?: unknown }
export type EmissionResult = { readonly ok: true; readonly value: EmissionSuccess } | { readonly ok: false; readonly error: EmissionError };

export interface EmitSurveyInput<E> {
  readonly source: LookoutSource;
  readonly current: ProposalSetObservation;
  readonly check: ObservationCheckAnchor;
  readonly callbacks: Omit<ProposalSetDiffInput<E>, "prior" | "current">;
}
export interface SurveyEmitter<E> { emit(input: EmitSurveyInput<E>): Promise<EmissionResult> }
export interface CreateSurveyEmitterOptions<E> {
  readonly store: ObservationStore;
  readonly now?: () => string;
  readonly diff?: (input: ProposalSetDiffInput<E>) => { readonly ok: true; readonly value: ProposalSetDiff } | { readonly ok: false; readonly error: { readonly message: string } };
  /** Test seam. Production callers must leave this as observation. */
  readonly resolution?: "observation";
  readonly transformSurveyInput?: (input: SurveyInput) => SurveyInput;
}

function id(...parts: readonly unknown[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function eventValue(event: ProposalDiffEvent): unknown {
  return event.kind === "new-entity-appeared"
    ? { kind: event.kind, entityKey: event.entityKey, currentValues: event.current.map((item) => ({ fieldKey: item.fieldKey, value: item.value })) }
    : { kind: event.kind, changeKind: event.changeKind, entityKey: event.entityKey, fieldKey: event.fieldKey, ...(event.prior ? { priorValue: event.prior.value } : {}), ...(event.current ? { currentValue: event.current.value } : {}) };
}

function observationFor(source: LookoutSource, prior: StoredProposalObservationV1, current: ProposalSetObservation, event: ProposalDiffEvent, generatedAt: string, index: number): SurveyObservationInput {
  const eventId = id(source.id, prior.observationId, current.snapshotRef, event.kind, event.entityKey, event.kind === "field-changed" ? event.fieldKey : "", index);
  const evidence = event.kind === "new-entity-appeared" ? event.current : [event.prior, event.current].filter((item) => item !== undefined);
  const primary = event.kind === "new-entity-appeared" ? event.current[0] : event.current ?? event.prior;
  const metadata = {
    sourceId: source.id, eventKind: event.kind, priorObservationId: prior.observationId,
    priorSnapshotRef: prior.snapshotRef, currentSnapshotRef: current.snapshotRef,
    evidence: evidence.map((item) => ({ snapshotRef: item.snapshotRef, locator: item.provenance.locator, excerpt: item.provenance.excerpt, extractor: item.extractor, fieldPath: item.fieldPath })),
    ...(event.kind === "field-changed" ? { changeKind: event.changeKind } : {}),
  };
  return {
    id: `lookout-${eventId}`,
    rawSource: { kind: source.kind, resolution: "observation", sourceRef: current.snapshotRef, observedAt: current.observedAt, locatorScheme: source.kind === "web-page" ? "html" : "structured-field", metadata },
    extraction: { target: `lookout:${event.entityKey}:${event.kind === "field-changed" ? event.fieldKey : "appearance"}`, value: eventValue(event), confidence: primary?.confidence, locator: primary?.provenance.locator, excerpt: primary?.provenance.excerpt, extractor: primary?.extractor ?? "lookout:proposal-diff", extractedAt: generatedAt, metadata },
    candidateSet: { status: "needs-review", metadata },
    claim: { subjectType: "lookout.observed-entity", subjectId: event.entityKey, facet: "lookout.source-change", claimType: event.kind === "new-entity-appeared" ? "lookout.new-entity-appeared" : "lookout.field-changed", fieldOrBehavior: event.kind === "field-changed" ? event.fieldKey : event.entityKey, value: eventValue(event), status: "proposed", impactLevel: "low", collectedBy: "@kontourai/lookout", createdAt: generatedAt, evidenceMethod: "observation", metadata },
  };
}

function containsAuthorizing(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthorizing);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key === "authorizing" || containsAuthorizing(item));
}
function validateSurveyInput(input: SurveyInput, source: LookoutSource, current: ProposalSetObservation, prior: StoredProposalObservationV1, events: readonly ProposalDiffEvent[]): boolean {
  if (input.reviewOutcomes.length !== 0 || containsAuthorizing(input)) return false;
  if (input.rawSources.length !== events.length || input.claims.length !== events.length) return false;
  for (const raw of input.rawSources) if (raw.kind !== source.kind || raw.resolution !== "observation" || raw.sourceRef !== current.snapshotRef) return false;
  for (let index = 0; index < events.length; index += 1) {
    const claim = input.claims[index]; const event = events[index];
    if (!claim || !event || claim.status !== "proposed" || claim.metadata?.priorSnapshotRef !== prior.snapshotRef || claim.metadata?.currentSnapshotRef !== current.snapshotRef) return false;
    const evidence = claim.metadata.evidence;
    if (!Array.isArray(evidence)) return false;
    if (event.kind === "new-entity-appeared" && !event.current.every((side) => evidence.some((item) => item && typeof item === "object" && (item as { snapshotRef?: unknown }).snapshotRef === side.snapshotRef))) return false;
    if (event.kind === "field-changed") {
      if (event.prior && !evidence.some((item) => item && typeof item === "object" && (item as { snapshotRef?: unknown }).snapshotRef === event.prior.snapshotRef)) return false;
      if (event.current && !evidence.some((item) => item && typeof item === "object" && (item as { snapshotRef?: unknown }).snapshotRef === event.current.snapshotRef)) return false;
      if (!event.current && !input.rawSources[index] || input.rawSources[index]?.sourceRef !== current.snapshotRef) return false;
    }
  }
  return true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function normalizeDiff(value: ProposalSetDiff): ProposalSetDiff {
  const sorted = <T>(items: readonly T[]) => [...items].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return { events: sorted(value.events), facts: { retainedProposalOccurrences: sorted(value.facts.retainedProposalOccurrences), addedProposalOccurrences: sorted(value.facts.addedProposalOccurrences), removedProposalOccurrences: sorted(value.facts.removedProposalOccurrences), provenanceChanges: sorted(value.facts.provenanceChanges), removedEntities: [...value.facts.removedEntities].sort() } };
}

export function createSurveyEmitter<E>(options: CreateSurveyEmitterOptions<E>): SurveyEmitter<E> {
  const now = options.now ?? (() => new Date().toISOString()); const diff = options.diff ?? diffProposalSets;
  return { async emit(input): Promise<EmissionResult> {
    try {
      if (options.resolution !== undefined && (options.resolution as ProvenanceResolution) !== "observation") return { ok: false, error: { kind: "invalid-input", message: "Lookout may author only observation resolution" } };
      if (!input.source || input.source.id !== input.current?.sourceId || input.check?.currentSnapshotRef !== input.current?.snapshotRef) return { ok: false, error: { kind: "invalid-input", message: "Registry source, observation, and check anchor must agree" } };
      const loaded = await options.store.loadLatest(input.source.id);
      if (!loaded.ok) return { ok: false, error: { kind: "prior-state-error", message: loaded.error.message, cause: loaded.error } };
      const recordedAt = now(); let events: readonly ProposalDiffEvent[] = []; let facts: readonly EmissionFact[]; let surveyInput: SurveyInput | null = null;
      if (loaded.value === null) {
        facts = [{ kind: "baseline-established", sourceId: input.source.id, snapshotRef: input.current.snapshotRef, observedAt: input.current.observedAt, origin: input.source.kind, resolution: "observation", proposalCount: input.current.proposals.length }];
      } else {
        let derived;
        try { derived = diff({ prior: { sourceId: loaded.value.sourceId, snapshotRef: loaded.value.snapshotRef, observedAt: loaded.value.observedAt, proposals: loaded.value.proposals }, current: input.current, ...input.callbacks }); }
        catch (cause) { return { ok: false, error: { kind: "diff-error", message: "Proposal diff threw", cause } }; }
        if (!derived.ok) return { ok: false, error: { kind: "diff-error", message: derived.error.message, cause: derived.error } };
        const normalized = normalizeDiff(derived.value);
        events = normalized.events;
        facts = [{ kind: "proposal-set-facts", priorSnapshotRef: loaded.value.snapshotRef, currentSnapshotRef: input.current.snapshotRef, origin: input.source.kind, resolution: "observation", value: normalized.facts }];
        if (events.length > 0) {
          try {
            const builder = new SurveyInputBuilder({ source: "@kontourai/lookout", generatedAt: recordedAt });
            builder.addObservations(events.map((event, index) => observationFor(input.source, loaded.value!, input.current, event, recordedAt, index)));
            surveyInput = builder.build();
            if (options.transformSurveyInput) surveyInput = options.transformSurveyInput(surveyInput);
            JSON.stringify(surveyInput);
            if (!validateSurveyInput(surveyInput, input.source, input.current, loaded.value, events)) return { ok: false, error: { kind: "authoring-error", message: "SurveyInput violated observation-only provenance" } };
          } catch (cause) { return { ok: false, error: { kind: "authoring-error", message: "Could not author SurveyInput", cause } }; }
        }
      }
      try { JSON.stringify({ events, facts, surveyInput }); }
      catch (cause) { return { ok: false, error: { kind: "authoring-error", message: "Emission result is not serializable", cause } }; }
      const committed = await options.store.commit({ observation: input.current, recordedAt, check: input.check }, loaded.value?.observationId ?? null);
      if (!committed.ok) return { ok: false, error: { kind: "persistence-error", message: committed.error.message, cause: committed.error } };
      return { ok: true, value: { sourceId: input.source.id, events, facts, surveyInput, committedObservation: committed.value, warnings: committed.warnings ?? [] } };
    } catch (cause) { return { ok: false, error: { kind: "authoring-error", message: "Emission failed", cause } }; }
  } };
}
