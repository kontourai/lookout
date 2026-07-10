import type { ExtractionProposal } from "@kontourai/traverse";
import {
  canonicalValueKey,
  type DiffKernelError,
  type DiffResult,
  type IdentityResult,
} from "./canonical-value.js";
import { compareStructural, diffKeyedMultiset } from "./structural-diff.js";

declare const proposalIdentityBrand: unique symbol;
export type ProposalIdentity = string & { readonly [proposalIdentityBrand]: "ProposalIdentity" };

export interface ProposalSetObservation {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly proposals: readonly ExtractionProposal[];
}

export interface ProposalEvidence {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly confidence: number;
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

export interface FieldChangedEvent {
  readonly kind: "field-changed";
  readonly entityKey: string;
  readonly fieldKey: string;
  readonly changeKind: FieldChangeKind;
  readonly prior?: ProposalEvidence;
  readonly current?: ProposalEvidence;
}

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

export interface ProposalSetFacts {
  readonly retainedProposalOccurrences: readonly ProposalOccurrencePair[];
  readonly addedProposalOccurrences: readonly ExtractionProposal[];
  readonly removedProposalOccurrences: readonly ExtractionProposal[];
  readonly provenanceChanges: readonly ProvenanceChangeFact[];
  readonly removedEntities: readonly string[];
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
    confidence: proposal.confidence,
    provenance: proposal.provenance,
    extractor: proposal.extractor,
    fieldPath: proposal.fieldPath,
    ...(Object.prototype.hasOwnProperty.call(proposal, "pathIndices")
      ? { pathIndices: proposal.pathIndices }
      : {}),
  };
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
    addedProposalOccurrences.push(...occurrences.value.additions);
    removedProposalOccurrences.push(...occurrences.value.removals);

    const priorFields = priorProposals.value.map((proposal) => ({ entity: pair.prior, proposal }));
    const currentFields = currentProposals.value.map((proposal) => ({ entity: pair.current, proposal }));
    const fields = diffKeyedMultiset(priorFields, currentFields, {
      identity: ({ entity, proposal }) => input.fieldIdentity(entity, proposal),
    });
    if (!fields.ok) return fields;
    for (const field of fields.value.retained) {
      const fieldKeyResult = identity("fieldIdentity", () => input.fieldIdentity(field.prior.entity, field.prior.proposal));
      if (!fieldKeyResult.ok) return fieldKeyResult;
      const fieldKey = fieldKeyResult.value;
      const comparison = compareStructural(field.prior.proposal, field.current.proposal, {
        value: (proposal) => proposal.candidateValue,
        provenance: (proposal) => proposal.provenance,
      });
      if (!comparison.ok) return comparison;
      const priorEvidence = evidence(input.prior, entityKey, fieldKey, field.prior.proposal);
      const currentEvidence = evidence(input.current, entityKey, fieldKey, field.current.proposal);
      if (comparison.value.provenanceChanged) {
        provenanceChanges.push({ entityKey, fieldKey, prior: priorEvidence, current: currentEvidence });
      }
      if (comparison.value.valueChanged) {
        const kind = changeKind(field.prior.proposal.candidateValue, field.current.proposal.candidateValue);
        if (!kind.ok) return kind;
        events.push({ kind: "field-changed", entityKey, fieldKey, changeKind: kind.value, prior: priorEvidence, current: currentEvidence });
      }
    }
    for (const field of fields.value.additions) {
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
    const current: ProposalEvidence[] = [];
    for (const proposal of proposals.value) {
      const fieldKey = identity("fieldIdentity", () => input.fieldIdentity(entity, proposal));
      if (!fieldKey.ok) return fieldKey;
      current.push(evidence(input.current, entityKeyResult.value, fieldKey.value, proposal));
      addedProposalOccurrences.push(proposal);
    }
    events.push({ kind: "new-entity-appeared", entityKey: entityKeyResult.value, current });
  }

  for (const entity of entities.value.removals) {
    const entityKeyResult = identity("entityIdentity", () => input.entityIdentity(entity));
    if (!entityKeyResult.ok) return entityKeyResult;
    removedEntities.push(entityKeyResult.value);
    const proposals = invoke("proposalsFor", () => input.proposalsFor(entity));
    if (!proposals.ok) return proposals;
    removedProposalOccurrences.push(...proposals.value);
  }

  return {
    ok: true,
    value: {
      events,
      facts: { retainedProposalOccurrences, addedProposalOccurrences, removedProposalOccurrences, provenanceChanges, removedEntities },
    },
  };
}
