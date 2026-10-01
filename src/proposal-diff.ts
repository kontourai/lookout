import type { ExtractionCoverageEntry, ExtractionPartialReason, ExtractionProposal, PreparedArtifact } from "@kontourai/traverse";
import {
  canonicalValueKey,
  type DiffKernelError,
  type DiffResult,
  type IdentityResult,
} from "./canonical-value.js";
import { compareStructural, diffKeyedMultiset } from "./structural-diff.js";
import { compareCodeUnits } from "./canonical-json.js";
import { anchorInPriorText, type PriorTextAnchor } from "./prior-text-anchor.js";

declare const proposalIdentityBrand: unique symbol;
export type ProposalIdentity = string & { readonly [proposalIdentityBrand]: "ProposalIdentity" };

export interface ProposalSetObservation {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly proposals: readonly ExtractionProposal[];
  /**
   * Present when the extraction behind `proposals` did not read and answer all
   * of its prepared text. A proposal missing from such an observation may sit
   * in text that was never read, so the diff reports it as unobserved, never
   * as removed.
   */
  readonly incomplete?: ProposalSetIncompleteness;
  /**
   * Traverse's identity for the prepared text behind `proposals`. A drift
   * emitter needs the prior's to verify re-prepared text before anchoring
   * entities against it.
   */
  readonly preparedArtifact?: PreparedArtifact;
}

/**
 * Why a proposal set does not cover all of its source text: Traverse's partial
 * reason, or `extraction-error` when the run failed without naming one.
 */
export interface ProposalSetIncompleteness {
  readonly reason: ExtractionPartialReason | "extraction-error";
  /** Traverse's per-chunk coverage for the run, when it reported one. */
  readonly coverage?: readonly ExtractionCoverageEntry[];
}

export interface ProposalEvidence {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly value: unknown;
  /** The proposal's own confidence; absent when the proposal carried none. Never defaulted. */
  readonly confidence?: number;
  readonly provenance: ExtractionProposal["provenance"];
  readonly extractor: string;
  readonly fieldPath: string;
  readonly pathIndices?: readonly number[];
}

export type FieldChangeKind =
  | "value-populated"
  | "value-updated"
  | "items-added"
  | "items-removed"
  | "value-replaced";

export interface NewEntityAppearedEvent {
  readonly kind: "new-entity-appeared";
  readonly entityKey: string;
  readonly current: readonly ProposalEvidence[];
}

interface FieldChangedEventCommon {
  readonly kind: "field-changed";
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly changeKind: FieldChangeKind;
}

export type FieldChangedEvent = FieldChangedEventCommon & (
  | { readonly prior: ProposalEvidence; readonly current: ProposalEvidence }
  | { readonly prior: ProposalEvidence; readonly current?: never }
  | { readonly prior?: never; readonly current: ProposalEvidence }
);

export type ProposalDiffEvent = NewEntityAppearedEvent | FieldChangedEvent;

export interface ProposalOccurrencePair {
  readonly prior: ExtractionProposal;
  readonly current: ExtractionProposal;
}

export interface ProvenanceChangeFact {
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly prior: ProposalEvidence;
  readonly current: ProposalEvidence;
}

/** A retained field whose excerpt was narrowed around a value that stayed put. */
export interface ExcerptBoundaryChangeFact extends ProvenanceChangeFact {
  /** Prior excerpt text before the current excerpt's start, ending in a blank line. */
  readonly droppedBefore: string;
  /** Prior excerpt text after the current excerpt's end, starting with a blank line. */
  readonly droppedAfter: string;
}

/**
 * A retained field that has a confidence on one side and none on the other.
 * Numeric differences between two present scores are not listed: provider
 * scores are uncalibrated and jitter between runs. Each evidence carries its
 * own confidence or omits the key. A fact, never an event.
 */
export interface ConfidenceChangeFact {
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly prior: ProposalEvidence;
  readonly current: ProposalEvidence;
}

export interface ProposalSetFacts {
  readonly retainedProposalOccurrences: readonly ProposalOccurrencePair[];
  readonly addedProposalOccurrences: readonly ExtractionProposal[];
  readonly removedProposalOccurrences: readonly ExtractionProposal[];
  readonly provenanceChanges: readonly ProvenanceChangeFact[];
  readonly removedEntities: readonly string[];
  /** Exact observation-anchored evidence for every added proposal occurrence. */
  readonly addedProposalEvidence?: readonly ProposalEvidence[];
  /** Exact observation-anchored evidence for every removed proposal occurrence. */
  readonly removedProposalEvidence?: readonly ProposalEvidence[];
  /** Retained fields whose confidence appeared or disappeared. */
  readonly confidenceChanges?: readonly ConfidenceChangeFact[];
  /**
   * Present when non-empty: retained fields whose equal string value sits at
   * the same offsets while the current excerpt is a narrower cut of the prior
   * one, citing nothing new and dropping only whole paragraphs. The cited value did
   * not move, so these are not in `provenanceChanges`; the exact occurrence
   * facts still list both locators, and each fact carries the dropped text.
   */
  readonly excerptBoundaryChanges?: readonly ExcerptBoundaryChangeFact[];
  /**
   * Current proposal occurrences missing from an incomplete prior observation.
   * The prior may have held them in text it never read, so they are not in the
   * added facts and raise no event. An occurrence of a field the prior did
   * read (moved or re-valued) is not listed here; it is an added occurrence.
   */
  readonly newlyObservedProposalOccurrences?: readonly ExtractionProposal[];
  /** Exact observation-anchored evidence for every newly observed proposal occurrence. */
  readonly newlyObservedProposalEvidence?: readonly ProposalEvidence[];
  /** Current entities missing from an incomplete prior observation. */
  readonly newlyObservedEntities?: readonly string[];
  /**
   * Present when the diff was given the prior's full prepared text: where each
   * newly observed entity's evidence sits in it. Entities whose evidence is
   * absent from that text are additions and are not listed here.
   */
  readonly newlyObservedEntityAnchors?: readonly NewlyObservedEntityAnchor[];
  /**
   * Prior proposal occurrences missing from an incomplete current observation.
   * Whether they were removed is unknown, so they are not in the removed facts.
   */
  readonly unobservedProposalOccurrences?: readonly ExtractionProposal[];
  /** Exact observation-anchored evidence for every unobserved proposal occurrence. */
  readonly unobservedProposalEvidence?: readonly ProposalEvidence[];
  /** Prior entities missing from an incomplete current observation. */
  readonly unobservedEntities?: readonly string[];
}

export interface NewlyObservedEntityAnchor {
  readonly entityKey: string;
  readonly anchor: Exclude<PriorTextAnchor, "absent">;
}

export interface ProposalSetDiff {
  readonly events: readonly ProposalDiffEvent[];
  readonly facts: ProposalSetFacts;
}

export interface ProposalSetDiffInput<E> {
  readonly prior: ProposalSetObservation;
  readonly current: ProposalSetObservation;
  readonly selectEntities: (observation: ProposalSetObservation) => readonly E[];
  readonly entityIdentity: (entity: E) => string | IdentityResult;
  readonly proposalsFor: (entity: E) => readonly ExtractionProposal[];
  readonly fieldIdentity: (entity: E, proposal: ExtractionProposal) => string | IdentityResult;
  /**
   * The incomplete prior's full prepared text, verified against its prepared
   * artifact and prepared the same way as the current text. With it, a current
   * entity none of whose exact excerpts occur anywhere in that text is reported
   * as added and raises `new-entity-appeared`; any other is newly observed.
   * Ignored when the prior is complete.
   */
  readonly priorPreparedText?: string;
}

function callbackError(label: string, cause: unknown): DiffKernelError {
  return { kind: "callback-threw", message: `${label} callback threw`, cause };
}

function invoke<T>(label: string, callback: () => T): DiffResult<T> {
  try {
    return { ok: true, value: callback() };
  } catch (cause) {
    return { ok: false, error: callbackError(label, cause) };
  }
}

function identity<K extends string>(label: string, callback: () => K | IdentityResult<K>): DiffResult<K> {
  const called = invoke(label, callback);
  if (!called.ok) return called;
  if (typeof called.value === "string") return { ok: true, value: called.value };
  return called.value.ok ? { ok: true, value: called.value.key } : called.value;
}

export function extractionProposalIdentity(proposal: ExtractionProposal): IdentityResult<ProposalIdentity> {
  try {
    const pathIndices = Object.prototype.hasOwnProperty.call(proposal, "pathIndices")
      ? { present: true, value: proposal.pathIndices }
      : { present: false };
    const encoded = canonicalValueKey({
      fieldPath: proposal.fieldPath,
      pathIndices,
      locator: proposal.provenance.locator,
    });
    return encoded.ok ? { ok: true, key: encoded.key as unknown as ProposalIdentity } : encoded;
  } catch (cause) {
    return {
      ok: false,
      error: { kind: "unsupported-value", message: "Extraction proposal identity could not be inspected", path: "$", cause },
    };
  }
}

function evidence(
  observation: ProposalSetObservation,
  entityKey: string,
  fieldKey: string,
  proposal: ExtractionProposal,
): ProposalEvidence {
  return {
    sourceId: observation.sourceId,
    snapshotRef: observation.snapshotRef,
    observedAt: observation.observedAt,
    entityKey,
    fieldKey,
    value: proposal.candidateValue,
    ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
    provenance: proposal.provenance,
    extractor: proposal.extractor,
    fieldPath: proposal.fieldPath,
    ...(Object.prototype.hasOwnProperty.call(proposal, "pathIndices")
      ? { pathIndices: proposal.pathIndices }
      : {}),
  };
}

type Provenance = ExtractionProposal["provenance"];

/**
 * Provenance as equality sees it: the occurrence the resolver settled on, not
 * how it was steered there. `selection` and `hintUsed` only record whether the
 * provider sent an optional hint; the span, index, match count and ambiguity
 * they led to all stay compared.
 */
function resolvedProvenance(provenance: Provenance): unknown {
  const occurrence: unknown = provenance.occurrence;
  if (typeof occurrence !== "object" || occurrence === null) return provenance;
  const { selection: _selection, hintUsed: _hintUsed, ...resolved } = occurrence as Record<string, unknown>;
  return { ...provenance, occurrence: resolved };
}

function excerptSpan(provenance: Provenance): { readonly start: number; readonly end: number } | null {
  const match = /^chars:(\d+)-(\d+)$/.exec(provenance.locator);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end - start === provenance.excerpt.length ? { start, end } : null;
}

/** Resolver facts that must not change when an excerpt is narrowed. */
function besidesExcerptCut(provenance: Provenance): unknown {
  const { excerpt: _excerpt, locator: _locator, occurrence, ...rest } = provenance as Provenance & Record<string, unknown>;
  if (typeof occurrence !== "object" || occurrence === null) return { rest, occurrence };
  // The match count, index and span describe the excerpt string, which differs
  // by construction; resolver version and ambiguity must not.
  const { selected: _selected, count: _count, selection: _selection, hintUsed: _hintUsed, ...steady } = occurrence as unknown as Record<string, unknown>;
  return { rest, occurrence: steady };
}

/** The resolver, when it ran, settled on exactly the span the locator names. */
function resolvedAtLocator(provenance: Provenance, span: { readonly start: number; readonly end: number }): boolean {
  const occurrence: unknown = provenance.occurrence;
  if (occurrence === undefined) return true;
  const selected = (occurrence as { selected?: { start?: unknown; end?: unknown } } | null)?.selected;
  return selected?.start === span.start && selected.end === span.end;
}

const wordCharacter = /[\p{L}\p{N}_]/u;
const lineBreaks = (text: string): string => text.replace(/\r\n?/g, "\n");
/** Dropped text ends with a blank line: a paragraph break before what was kept. */
const endsWithBlankLine = (text: string): boolean => /\n[^\S\n]*\n$/.test(lineBreaks(text));
/** Dropped text starts with a blank line: a paragraph break after what was kept. */
const startsWithBlankLine = (text: string): boolean => /^\n[^\S\n]*\n/.test(lineBreaks(text));

/** The value at `at` in `excerpt` is not the inside of a longer word or number. */
function onTokenBoundaries(excerpt: string, at: number, length: number): boolean {
  // Spread iterates code points, so an astral neighbour is tested whole.
  const before = [...excerpt.slice(Math.max(0, at - 2), at)].pop() ?? "";
  const after = [...excerpt.slice(at + length, at + length + 2)][0] ?? "";
  return !wordCharacter.test(before) && !wordCharacter.test(after);
}

/**
 * Whether the current proposal cites the same value at the same place as the
 * prior, from a strictly narrower excerpt that cites nothing new. Returns the
 * text the narrowing dropped, or `null` when the pair is a real provenance
 * change. All of these must hold:
 *
 * - an equal, non-empty string value;
 * - well-formed `chars:` locators that the resolver, if it ran, settled on;
 * - a current span strictly inside the prior span, with the same text there;
 * - only whole paragraphs dropped: a blank line separates the dropped text
 *   from what is kept, so a hard-wrapped sentence is never cut;
 * - the value first found at the same absolute offset in both excerpts, and
 *   not as part of a longer word or number in either;
 * - resolver version and ambiguity unchanged.
 *
 * Widening, shifting, dropping text beside the value, a different occurrence,
 * or a value the excerpt does not literally contain is never a narrowing.
 */
function narrowedAroundValue(prior: ExtractionProposal, current: ExtractionProposal): DiffResult<{ readonly droppedBefore: string; readonly droppedAfter: string } | null> {
  const no = { ok: true, value: null } as const;
  const value: unknown = prior.candidateValue;
  if (typeof value !== "string" || value.length === 0 || current.candidateValue !== value) return no;
  const priorSpan = excerptSpan(prior.provenance);
  const currentSpan = excerptSpan(current.provenance);
  if (priorSpan === null || currentSpan === null) return no;
  if (!resolvedAtLocator(prior.provenance, priorSpan) || !resolvedAtLocator(current.provenance, currentSpan)) return no;
  // Stated for the reader; the text comparison below also fails for any span
  // that is not inside the prior's.
  if (currentSpan.start < priorSpan.start || currentSpan.end > priorSpan.end) return no;
  if (currentSpan.start === priorSpan.start && currentSpan.end === priorSpan.end) return no;
  const priorExcerpt = prior.provenance.excerpt;
  const currentExcerpt = current.provenance.excerpt;
  const droppedBefore = priorExcerpt.slice(0, currentSpan.start - priorSpan.start);
  const droppedAfter = priorExcerpt.slice(currentSpan.end - priorSpan.start);
  if (priorExcerpt.slice(droppedBefore.length, priorExcerpt.length - droppedAfter.length) !== currentExcerpt) return no;
  if (droppedBefore !== "" && !endsWithBlankLine(droppedBefore)) return no;
  if (droppedAfter !== "" && !startsWithBlankLine(droppedAfter)) return no;
  const priorAt = priorExcerpt.indexOf(value);
  const currentAt = currentExcerpt.indexOf(value);
  if (priorAt < 0 || currentAt < 0 || priorSpan.start + priorAt !== currentSpan.start + currentAt) return no;
  if (!onTokenBoundaries(priorExcerpt, priorAt, value.length) || !onTokenBoundaries(currentExcerpt, currentAt, value.length)) return no;
  const priorRest = canonicalValueKey(besidesExcerptCut(prior.provenance));
  if (!priorRest.ok) return priorRest;
  const currentRest = canonicalValueKey(besidesExcerptCut(current.provenance));
  if (!currentRest.ok) return currentRest;
  return priorRest.key === currentRest.key ? { ok: true, value: { droppedBefore, droppedAfter } } : no;
}

function changeKind(prior: unknown, current: unknown): DiffResult<FieldChangeKind> {
  if (prior === undefined && current !== undefined) return { ok: true, value: "value-populated" };
  if (Array.isArray(prior) && Array.isArray(current)) {
    const facts = diffKeyedMultiset(prior, current, { identity: canonicalValueKey });
    if (!facts.ok) return facts;
    const added = facts.value.additions.length > 0;
    const removed = facts.value.removals.length > 0;
    if (added && !removed) return { ok: true, value: "items-added" };
    if (removed && !added) return { ok: true, value: "items-removed" };
    return { ok: true, value: "value-replaced" };
  }
  const sameCategory = (prior === null ? "null" : typeof prior) === (current === null ? "null" : typeof current);
  return { ok: true, value: sameCategory ? "value-updated" : "value-replaced" };
}

function semanticFieldOrder<E>(items: readonly { entity: E; proposal: ExtractionProposal }[], fieldIdentity: (item: { entity: E; proposal: ExtractionProposal }) => string | IdentityResult): DiffResult<readonly { entity: E; proposal: ExtractionProposal }[]> {
  const groups = new Map<string, Array<{ item: { entity: E; proposal: ExtractionProposal }; key: string; index: number }>>();
  for (const [index, item] of items.entries()) {
    const fieldKey = identity("fieldIdentity", () => fieldIdentity(item));
    if (!fieldKey.ok) return fieldKey;
    let encoded;
    try {
      encoded = canonicalValueKey({ value: item.proposal.candidateValue, provenance: resolvedProvenance(item.proposal.provenance) });
    } catch (cause) {
      return { ok: false, error: { kind: "unsupported-value", message: "Proposal semantic content could not be inspected", path: "$", cause } };
    }
    if (!encoded.ok) return encoded;
    groups.set(fieldKey.value, [...(groups.get(fieldKey.value) ?? []), { item, key: encoded.key, index }]);
  }
  const ordered = [...groups.values()].flatMap((group) => group.sort((left, right) => compareCodeUnits(left.key, right.key) || left.index - right.index));
  return { ok: true, value: ordered.map(({ item }) => item) };
}

export function diffProposalSets<E>(input: ProposalSetDiffInput<E>): DiffResult<ProposalSetDiff> {
  if (input.prior.sourceId !== input.current.sourceId) {
    return {
      ok: false,
      error: { kind: "unsupported-value", message: "Proposal observations must have the same sourceId", path: "$.sourceId" },
    };
  }

  const priorEntities = invoke("selectEntities", () => input.selectEntities(input.prior));
  if (!priorEntities.ok) return priorEntities;
  const currentEntities = invoke("selectEntities", () => input.selectEntities(input.current));
  if (!currentEntities.ok) return currentEntities;
  const entities = diffKeyedMultiset(priorEntities.value, currentEntities.value, {
    identity: (entity) => input.entityIdentity(entity),
  });
  if (!entities.ok) return entities;

  const events: ProposalDiffEvent[] = [];
  const retainedProposalOccurrences: ProposalOccurrencePair[] = [];
  const addedProposalOccurrences: ExtractionProposal[] = [];
  const removedProposalOccurrences: ExtractionProposal[] = [];
  const provenanceChanges: ProvenanceChangeFact[] = [];
  const removedEntities: string[] = [];
  const addedProposalEvidence: ProposalEvidence[] = [];
  const removedProposalEvidence: ProposalEvidence[] = [];
  const confidenceChanges: ConfidenceChangeFact[] = [];
  const excerptBoundaryChanges: ExcerptBoundaryChangeFact[] = [];
  const unobservedProposalOccurrences: ExtractionProposal[] = [];
  const unobservedProposalEvidence: ProposalEvidence[] = [];
  const unobservedEntities: string[] = [];
  // Text the current extraction never read may still hold what the prior saw,
  // so nothing the prior had can be called removed.
  const currentIncomplete = input.current.incomplete !== undefined;
  // Symmetrically, what the current run has that an incomplete prior lacks may
  // have been in the prior's unread text, so it is not called added.
  const priorIncomplete = input.prior.incomplete !== undefined;
  const newlyObservedProposalOccurrences: ExtractionProposal[] = [];
  const newlyObservedProposalEvidence: ProposalEvidence[] = [];
  const newlyObservedEntities: string[] = [];
  const newlyObservedEntityAnchors: NewlyObservedEntityAnchor[] = [];
  const priorText = priorIncomplete ? input.priorPreparedText : undefined;

  for (const pair of entities.value.retained) {
    const entityKeyResult = identity("entityIdentity", () => input.entityIdentity(pair.prior));
    if (!entityKeyResult.ok) return entityKeyResult;
    const entityKey = entityKeyResult.value;
    const priorProposals = invoke("proposalsFor", () => input.proposalsFor(pair.prior));
    if (!priorProposals.ok) return priorProposals;
    const currentProposals = invoke("proposalsFor", () => input.proposalsFor(pair.current));
    if (!currentProposals.ok) return currentProposals;

    const occurrences = diffKeyedMultiset(priorProposals.value, currentProposals.value, {
      identity: extractionProposalIdentity,
    });
    if (!occurrences.ok) return occurrences;
    retainedProposalOccurrences.push(...occurrences.value.retained);
    (currentIncomplete ? unobservedProposalOccurrences : removedProposalOccurrences).push(...occurrences.value.removals);

    const priorFields = semanticFieldOrder(priorProposals.value.map((proposal) => ({ entity: pair.prior, proposal })), ({ entity, proposal }) => input.fieldIdentity(entity, proposal));
    if (!priorFields.ok) return priorFields;
    const currentFields = semanticFieldOrder(currentProposals.value.map((proposal) => ({ entity: pair.current, proposal })), ({ entity, proposal }) => input.fieldIdentity(entity, proposal));
    if (!currentFields.ok) return currentFields;
    const fields = diffKeyedMultiset(priorFields.value, currentFields.value, {
      identity: ({ entity, proposal }) => input.fieldIdentity(entity, proposal),
    });
    if (!fields.ok) return fields;
    // An occurrence whose field the prior did read (moved, re-worded or
    // re-valued) is an added occurrence even against an incomplete prior: the
    // field-level facts and events already describe it, so calling it newly
    // observed would count the same field twice.
    const priorReadField = new Set(fields.value.retained.map((field) => field.current.proposal));
    for (const proposal of occurrences.value.additions) {
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(pair.current, proposal));
      if (!fieldKey.ok) return fieldKey;
      const newlyObserved = priorIncomplete && !priorReadField.has(proposal);
      (newlyObserved ? newlyObservedProposalOccurrences : addedProposalOccurrences).push(proposal);
      (newlyObserved ? newlyObservedProposalEvidence : addedProposalEvidence).push(evidence(input.current, entityKey, fieldKey.value, proposal));
    }
    for (const proposal of occurrences.value.removals) {
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(pair.prior, proposal));
      if (!fieldKey.ok) return fieldKey;
      (currentIncomplete ? unobservedProposalEvidence : removedProposalEvidence).push(evidence(input.prior, entityKey, fieldKey.value, proposal));
    }

    for (const field of fields.value.retained) {
      const fieldKeyResult = identity("fieldIdentity", () => input.fieldIdentity(field.prior.entity, field.prior.proposal));
      if (!fieldKeyResult.ok) return fieldKeyResult;
      const fieldKey = fieldKeyResult.value;
      const comparison = compareStructural(field.prior.proposal, field.current.proposal, {
        value: (proposal) => proposal.candidateValue,
        provenance: (proposal) => resolvedProvenance(proposal.provenance),
      });
      if (!comparison.ok) return comparison;
      const priorEvidence = evidence(input.prior, entityKey, fieldKey, field.prior.proposal);
      const currentEvidence = evidence(input.current, entityKey, fieldKey, field.current.proposal);
      if (comparison.value.provenanceChanged) {
        const narrowed = comparison.value.valueChanged
          ? ({ ok: true, value: null } as const)
          : narrowedAroundValue(field.prior.proposal, field.current.proposal);
        if (!narrowed.ok) return narrowed;
        if (narrowed.value === null) provenanceChanges.push({ entityKey, fieldKey, prior: priorEvidence, current: currentEvidence });
        else excerptBoundaryChanges.push({ entityKey, fieldKey, prior: priorEvidence, current: currentEvidence, ...narrowed.value });
      }
      if ((field.prior.proposal.confidence === undefined) !== (field.current.proposal.confidence === undefined)) {
        confidenceChanges.push({ entityKey, fieldKey, prior: priorEvidence, current: currentEvidence });
      }
      if (comparison.value.valueChanged) {
        const kind = changeKind(field.prior.proposal.candidateValue, field.current.proposal.candidateValue);
        if (!kind.ok) return kind;
        events.push({ kind: "field-changed", entityKey, fieldKey, changeKind: kind.value, prior: priorEvidence, current: currentEvidence });
      }
    }
    for (const field of fields.value.additions) {
      if (priorIncomplete) continue;
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(field.entity, field.proposal));
      if (!fieldKey.ok) return fieldKey;
      events.push({
        kind: "field-changed",
        entityKey,
        fieldKey: fieldKey.value,
        changeKind: "value-populated",
        current: evidence(input.current, entityKey, fieldKey.value, field.proposal),
      });
    }
    for (const field of fields.value.removals) {
      if (currentIncomplete) continue;
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(field.entity, field.proposal));
      if (!fieldKey.ok) return fieldKey;
      events.push({
        kind: "field-changed",
        entityKey,
        fieldKey: fieldKey.value,
        changeKind: Array.isArray(field.proposal.candidateValue) ? "items-removed" : "value-replaced",
        prior: evidence(input.prior, entityKey, fieldKey.value, field.proposal),
      });
    }
  }

  for (const entity of entities.value.additions) {
    const entityKeyResult = identity("entityIdentity", () => input.entityIdentity(entity));
    if (!entityKeyResult.ok) return entityKeyResult;
    const proposals = invoke("proposalsFor", () => input.proposalsFor(entity));
    if (!proposals.ok) return proposals;
    // Against an incomplete prior an entity is only added when its text was
    // nowhere in the prior's capture; offsets cannot tell, since each capture
    // has its own.
    const anchor = priorText === undefined ? null : anchorInPriorText(proposals.value, priorText, input.prior.incomplete?.coverage ?? []);
    const unseen = priorIncomplete && anchor !== "absent";
    const current: ProposalEvidence[] = [];
    for (const proposal of proposals.value) {
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(entity, proposal));
      if (!fieldKey.ok) return fieldKey;
      current.push(evidence(input.current, entityKeyResult.value, fieldKey.value, proposal));
      (unseen ? newlyObservedProposalEvidence : addedProposalEvidence).push(evidence(input.current, entityKeyResult.value, fieldKey.value, proposal));
      (unseen ? newlyObservedProposalOccurrences : addedProposalOccurrences).push(proposal);
    }
    if (unseen) {
      newlyObservedEntities.push(entityKeyResult.value);
      if (anchor !== null) newlyObservedEntityAnchors.push({ entityKey: entityKeyResult.value, anchor });
    } else events.push({ kind: "new-entity-appeared", entityKey: entityKeyResult.value, current });
  }

  for (const entity of entities.value.removals) {
    const entityKeyResult = identity("entityIdentity", () => input.entityIdentity(entity));
    if (!entityKeyResult.ok) return entityKeyResult;
    (currentIncomplete ? unobservedEntities : removedEntities).push(entityKeyResult.value);
    const proposals = invoke("proposalsFor", () => input.proposalsFor(entity));
    if (!proposals.ok) return proposals;
    (currentIncomplete ? unobservedProposalOccurrences : removedProposalOccurrences).push(...proposals.value);
    for (const proposal of proposals.value) {
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(entity, proposal));
      if (!fieldKey.ok) return fieldKey;
      (currentIncomplete ? unobservedProposalEvidence : removedProposalEvidence).push(evidence(input.prior, entityKeyResult.value, fieldKey.value, proposal));
    }
  }

  return {
    ok: true,
    value: {
      events,
      facts: {
        retainedProposalOccurrences, addedProposalOccurrences, removedProposalOccurrences, provenanceChanges, removedEntities, addedProposalEvidence, removedProposalEvidence, confidenceChanges,
        ...(excerptBoundaryChanges.length === 0 ? {} : { excerptBoundaryChanges }),
        ...(priorIncomplete ? { newlyObservedProposalOccurrences, newlyObservedProposalEvidence, newlyObservedEntities } : {}),
        ...(priorText === undefined ? {} : { newlyObservedEntityAnchors }),
        ...(currentIncomplete ? { unobservedProposalOccurrences, unobservedProposalEvidence, unobservedEntities } : {}),
      },
    },
  };
}
