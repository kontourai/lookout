import { createHash } from "node:crypto";
import type { TargetFieldSchema } from "@kontourai/traverse";
import { canonicalValueKey, type DiffResult } from "./canonical-value.js";
import { checkSchemaCoverage } from "./coverage.js";
import type { ProposalEvidence, ProposalSetDiff, ProposalSetObservation } from "./proposal-diff.js";
import { semanticReviewApiVersion, type SemanticClaimTarget, type SemanticObservationIdentity, type SemanticReviewCandidate, type SemanticReviewChange, type SemanticReviewItem } from "./semantic-review-types.js";

export function reviewKey(value: unknown): DiffResult<string> {
  const canonical = canonicalValueKey(value);
  return canonical.ok ? { ok: true, value: createHash("sha256").update(canonical.key).digest("hex").slice(0, 24) } : sanitizeError(canonical);
}
export function sanitizeError<T>(result: DiffResult<T>): DiffResult<T> {
  if (result.ok) return result;
  return { ok: false, error: { kind: result.error.kind, message: "Semantic review derivation failed" } };
}
export function validateObservationIdentity(identity: SemanticObservationIdentity): DiffResult<SemanticObservationIdentity> {
  for (const [name, value] of Object.entries(identity)) if (typeof value !== "string" || value.length === 0 || /authorization\s*[:=]|bearer\s+|(?:token|secret|password|api[-_]?key)=/i.test(value)) {
    return { ok: false, error: { kind: "unsupported-value", message: `${name} observation identity is invalid`, path: `$.observationIdentity.${name}` } };
  }
  return { ok: true, value: identity };
}
const incomplete = (evidence: ProposalEvidence): boolean => evidence.provenance.locator.length === 0 || evidence.provenance.excerpt.length === 0;
const sameEvidence = (left: ProposalEvidence, right: ProposalEvidence): boolean => left.entityKey === right.entityKey && left.fieldKey === right.fieldKey && left.snapshotRef === right.snapshotRef && left.provenance.locator === right.provenance.locator && left.provenance.excerpt === right.provenance.excerpt;
const addedKind = (current: ProposalEvidence): SemanticReviewChange["kind"] => incomplete(current) ? "provenance-gap" : "proposal-added";

export function collectSemanticChanges(input: { prior: ProposalSetObservation; current: ProposalSetObservation; schema?: readonly TargetFieldSchema[] }, diff: ProposalSetDiff): SemanticReviewChange[] {
  const changes: SemanticReviewChange[] = [];
  for (const event of diff.events) {
    if (event.kind === "new-entity-appeared") for (const current of event.current) changes.push({ kind: addedKind(current), fieldPath: current.fieldPath, entityKey: current.entityKey, current });
    else if (event.prior && event.current) changes.push({ kind: "proposal-value-changed", fieldPath: event.current.fieldPath, entityKey: event.entityKey, prior: event.prior, current: event.current });
    else if (event.current) changes.push({ kind: addedKind(event.current), fieldPath: event.current.fieldPath, entityKey: event.entityKey, current: event.current });
    else if (event.prior) changes.push({ kind: "proposal-removed", fieldPath: event.prior.fieldPath, entityKey: event.entityKey, prior: event.prior });
  }
  const representedPrior = changes.flatMap((change) => change.prior ? [change.prior] : []);
  const representedCurrent = changes.flatMap((change) => change.current ? [change.current] : []);
  // A field pair the diff already correlated accounts for both of its exact
  // occurrences, whether its provenance changed or only its excerpt was re-cut.
  const correlated = [...diff.facts.provenanceChanges, ...(diff.facts.excerptBoundaryChanges ?? [])];
  for (const prior of diff.facts.removedProposalEvidence ?? []) if (!correlated.some((item) => sameEvidence(item.prior, prior)) && !representedPrior.some((item) => sameEvidence(item, prior))) changes.push({ kind: "proposal-removed", fieldPath: prior.fieldPath, entityKey: prior.entityKey, prior });
  for (const current of diff.facts.addedProposalEvidence ?? []) if (!correlated.some((item) => sameEvidence(item.current, current)) && !representedCurrent.some((item) => sameEvidence(item, current))) changes.push({ kind: addedKind(current), fieldPath: current.fieldPath, entityKey: current.entityKey, current });
  // Against an incomplete prior, what the current run has that the prior
  // lacked may be new or may have sat in text the prior never read. Nothing
  // decides which, so a reviewer does.
  for (const current of diff.facts.newlyObservedProposalEvidence ?? []) changes.push({ kind: "proposal-newly-observed", fieldPath: current.fieldPath, entityKey: current.entityKey, current });
  // One field change is one item: a value change already carries both sides'
  // locators and excerpts, so the same pair's provenance change is not listed
  // again. Matching is by object identity, so only that exact pair is merged.
  // A pair that lost its provenance still gets its own gap item.
  const valueChanged = changes.filter((change) => change.kind === "proposal-value-changed");
  for (const change of diff.facts.provenanceChanges) {
    const kind = incomplete(change.current) && !incomplete(change.prior) ? "provenance-gap" : change.prior.provenance.locator !== change.current.provenance.locator ? "proposal-moved" : "proposal-provenance-changed";
    if (kind !== "provenance-gap" && valueChanged.some((item) => item.prior === change.prior && item.current === change.current)) continue;
    changes.push({ kind, fieldPath: change.current.fieldPath, entityKey: change.entityKey, prior: change.prior, current: change.current });
  }
  // A declared field missing from text that was never read is unknown, not a gap.
  if (input.schema && input.current.incomplete === undefined) {
    const priorGaps = new Set(checkSchemaCoverage(input.schema, input.prior.proposals).gaps.map((gap) => gap.fieldPath));
    for (const gap of checkSchemaCoverage(input.schema, input.current.proposals).gaps) if (!priorGaps.has(gap.fieldPath)) changes.push({ kind: "coverage-gap", fieldPath: gap.fieldPath, entityKey: gap.fieldPath, gap });
  }
  return changes;
}
function candidate(id: string, role: SemanticReviewCandidate["role"], observationId: string, evidence: ProposalEvidence | undefined, fallback: ProposalSetObservation, target: SemanticClaimTarget, fieldPath: string): SemanticReviewCandidate {
  const present = evidence !== undefined;
  return { id: `${id}.${role}`, role, value: present ? evidence.value : null, ...(evidence?.confidence === undefined ? {} : { confidence: evidence.confidence }), source: { sourceRef: evidence?.snapshotRef ?? fallback.snapshotRef, sourceId: evidence?.sourceId ?? fallback.sourceId, observedAt: evidence?.observedAt ?? fallback.observedAt, locatorScheme: "text-span" }, ...(present && !incomplete(evidence) ? { locator: { scheme: "text-span", locator: evidence.provenance.locator, excerpt: evidence.provenance.excerpt } } : {}), extraction: { extractionId: `${id}.${role}.extraction`, target: fieldPath, ...(present ? { ...(evidence.confidence === undefined ? {} : { confidence: evidence.confidence }), extractor: evidence.extractor } : {}), extractedAt: evidence?.observedAt ?? fallback.observedAt }, claimTarget: target, producer: { "lookout.kontourai.io/semantic-transition": { observationId, evidenceState: present ? "present" : "absent" } } };
}

export function projectReviewItem(change: SemanticReviewChange, occurrence: number, transitionId: string, identities: SemanticObservationIdentity, prior: ProposalSetObservation, current: ProposalSetObservation, target: SemanticClaimTarget): DiffResult<SemanticReviewItem> {
  const itemIdentity = reviewKey({ transitionId, change, occurrence });
  if (!itemIdentity.ok) return itemIdentity;
  const name = `lookout-semantic.${itemIdentity.value}`;
  const candidates = [candidate(name, "current", identities.prior, change.prior, prior, target, change.fieldPath), candidate(name, "proposed", identities.current, change.current, current, target, change.fieldPath)];
  return { ok: true, value: { apiVersion: semanticReviewApiVersion, kind: "ReviewItem", metadata: { name, producer: { "lookout.kontourai.io/semantic-transition": { semanticKind: change.kind, transitionId, priorObservationId: identities.prior, currentObservationId: identities.current } } }, spec: { target: change.fieldPath, candidates, candidateSetStatus: "needs-review", editable: false }, status: { observedCandidateCount: candidates.length } } };
}
