import type { TargetFieldSchema } from "@kontourai/traverse";
import type { SchemaCoverageGap } from "./coverage.js";
import type { ProposalEvidence, ProposalSetDiffInput, ProposalSetObservation } from "./proposal-diff.js";

export const semanticReviewApiVersion = "survey.kontourai.io/v1alpha1";

export type SemanticReviewKind = "proposal-added" | "proposal-removed" | "proposal-moved" |
  "proposal-provenance-changed" | "proposal-value-changed" | "coverage-gap" | "provenance-gap";
export interface SemanticObservationIdentity { readonly prior: string; readonly current: string }
export interface SemanticClaimTarget {
  readonly subjectType: string; readonly subjectId: string; readonly facet: string;
  readonly claimType: string; readonly fieldOrBehavior: string;
  readonly impactLevel: "low" | "medium" | "high" | "critical";
  readonly [key: string]: unknown;
}
export interface SemanticReviewCandidate {
  readonly id: string; readonly role: "current" | "proposed" | "source-version"; readonly value: unknown;
  readonly confidence?: number;
  readonly source: { readonly sourceRef: string; readonly sourceId: string; readonly observedAt: string; readonly locatorScheme: "text-span" };
  readonly locator?: { readonly scheme: "text-span"; readonly locator: string; readonly excerpt: string };
  readonly extraction: { readonly extractionId: string; readonly target: string; readonly confidence?: number; readonly extractor?: string; readonly extractedAt: string };
  readonly claimTarget: SemanticClaimTarget;
  readonly producer: { readonly "lookout.kontourai.io/semantic-transition": { readonly observationId: string; readonly evidenceState: "present" | "absent" } };
}
/** Structural match for Survey ReviewItem; Lookout deliberately imports no review package. */
export interface SemanticReviewItem {
  readonly apiVersion: typeof semanticReviewApiVersion; readonly kind: "ReviewItem";
  readonly metadata: { readonly name: string; readonly producer: { readonly "lookout.kontourai.io/semantic-transition": { readonly semanticKind: SemanticReviewKind; readonly transitionId: string; readonly priorObservationId: string; readonly currentObservationId: string } } };
  readonly spec: { readonly target: string; readonly candidates: SemanticReviewCandidate[]; readonly candidateSetStatus: "needs-review"; readonly editable: false };
  readonly status: { readonly observedCandidateCount: number };
}
export interface SemanticReviewChange {
  readonly kind: SemanticReviewKind; readonly fieldPath: string; readonly entityKey: string;
  readonly prior?: ProposalEvidence; readonly current?: ProposalEvidence; readonly gap?: SchemaCoverageGap;
}
export interface SemanticReviewWork {
  readonly transitionId: string; readonly priorObservationId: string; readonly currentObservationId: string;
  readonly items: readonly SemanticReviewItem[];
}
export interface BuildSemanticReviewWorkInput<E> extends Omit<ProposalSetDiffInput<E>, "prior" | "current"> {
  readonly prior: ProposalSetObservation; readonly current: ProposalSetObservation;
  readonly observationIdentity: SemanticObservationIdentity; readonly schema?: readonly TargetFieldSchema[];
  readonly claimTarget: (change: SemanticReviewChange) => SemanticClaimTarget;
}
