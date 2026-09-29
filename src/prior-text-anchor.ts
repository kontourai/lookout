import { EXACT_OCCURRENCE_RESOLVER_VERSION, type ExtractionCoverageEntry, type ExtractionProposal } from "@kontourai/traverse";

/**
 * Where a current entity's evidence sits in an incomplete prior's full
 * prepared text:
 * - `absent`: no excerpt occurs anywhere in it, so the capture the prior read
 *   did not hold this text at all. The entity is an addition.
 * - `prior-read-text`: an excerpt occurs inside a range the prior sent to its
 *   provider, which did not propose it. A proposer difference, not an addition.
 * - `prior-unread-text`: an excerpt occurs only in text the prior never read,
 *   for example an entity an insertion shifted into the read window.
 * - `unanchorable`: an excerpt is empty or was not placed by Traverse's exact
 *   occurrence resolver, so its absence would prove nothing.
 */
export type PriorTextAnchor = "absent" | "prior-read-text" | "prior-unread-text" | "unanchorable";

/**
 * Anchor one entity's proposals in the prior's full prepared text. Every
 * excerpt must be absent for `absent`: an entity that kept any of its text
 * was in the prior capture.
 */
export function anchorInPriorText(proposals: readonly ExtractionProposal[], priorText: string, priorCoverage: readonly ExtractionCoverageEntry[]): PriorTextAnchor {
  if (proposals.length === 0) return "unanchorable";
  let found: PriorTextAnchor | null = null;
  for (const proposal of proposals) {
    const excerpt = proposal.provenance.excerpt;
    if (excerpt.length === 0 || proposal.provenance.occurrence?.resolverVersion !== EXACT_OCCURRENCE_RESOLVER_VERSION) return "unanchorable";
    let at = priorText.indexOf(excerpt);
    while (at !== -1 && found !== "prior-read-text") {
      const end = at + excerpt.length;
      found = priorCoverage.some((entry) => entry.status !== "unread" && entry.start <= at && end <= entry.end) ? "prior-read-text" : "prior-unread-text";
      at = priorText.indexOf(excerpt, at + 1);
    }
  }
  return found ?? "absent";
}
