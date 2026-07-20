import { diffProposalSets } from "./proposal-diff.js";
import { collectSemanticChanges, projectReviewItem, reviewKey, sanitizeError, validateObservationIdentity } from "./semantic-review-projection.js";
import type { BuildSemanticReviewWorkInput, SemanticClaimTarget, SemanticReviewItem, SemanticReviewWork } from "./semantic-review-types.js";

export { semanticReviewApiVersion } from "./semantic-review-types.js";
export type { BuildSemanticReviewWorkInput, SemanticClaimTarget, SemanticObservationIdentity, SemanticReviewCandidate, SemanticReviewChange, SemanticReviewItem, SemanticReviewKind, SemanticReviewWork } from "./semantic-review-types.js";

/** Project one genuine proposal-observation transition into deterministic review work. */
export function buildSemanticReviewWork<E>(input: BuildSemanticReviewWorkInput<E>): import("./canonical-value.js").DiffResult<SemanticReviewWork> {
  const identities = validateObservationIdentity(input.observationIdentity);
  if (!identities.ok) return identities;
  const diff = diffProposalSets(input);
  if (!diff.ok) return sanitizeError(diff);
  const transition = reviewKey({ sourceId: input.current.sourceId, priorObservationId: identities.value.prior, currentObservationId: identities.value.current });
  if (!transition.ok) return transition;
  const items: SemanticReviewItem[] = [];
  const occurrences = new Map<string, number>();
  for (const change of collectSemanticChanges(input, diff.value)) {
    let target: SemanticClaimTarget;
    try { target = input.claimTarget(change); } catch {
      return { ok: false, error: { kind: "callback-threw", message: "claimTarget callback threw", path: "$.claimTarget" } };
    }
    const base = reviewKey(change);
    if (!base.ok) return base;
    const occurrence = occurrences.get(base.value) ?? 0;
    occurrences.set(base.value, occurrence + 1);
    const item = projectReviewItem(change, occurrence, transition.value, identities.value, input.prior, input.current, target);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: { transitionId: transition.value, priorObservationId: identities.value.prior, currentObservationId: identities.value.current, items } };
}
