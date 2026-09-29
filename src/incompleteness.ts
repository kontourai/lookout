import type { ProposalSetIncompleteness } from "./proposal-diff.js";

// Losses fixed by the capture and the extraction configuration: the content
// cap, the chunk cap, and the provider-call ceiling. Running the same capture
// again would lose the same text again.
const RECURRING_REASONS: ReadonlySet<string> = new Set(["content-truncated", "max-chunks", "max-provider-calls"]);

/**
 * Whether every loss of an incomplete run would recur on the same capture. The
 * partial reason names only the first loss; coverage has the rest.
 */
export function lossRecurs(incomplete: ProposalSetIncompleteness): boolean {
  if (!RECURRING_REASONS.has(incomplete.reason)) return false;
  return (incomplete.coverage ?? []).every((entry) => entry.status === "complete" ||
    (entry.status === "unread" && (entry.reason === "content-truncated" || entry.reason === "not-dispatched")));
}

const REASONS: ReadonlySet<string> = new Set(["cancelled", "max-provider-calls", "max-total-tokens", "max-chunks", "provider-failure", "content-truncated", "output-truncated", "extraction-error"]);
const STATUSES: ReadonlySet<string> = new Set(["complete", "unread", "output-truncated"]);
const UNREAD_REASONS: ReadonlySet<string> = new Set(["provider-failure", "content-truncated", "missing-tool-call", "not-dispatched"]);

/** Structural check of a persisted or caller-supplied incompleteness marker. */
export function validIncompleteness(value: unknown): value is ProposalSetIncompleteness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.reason !== "string" || !REASONS.has(item.reason)) return false;
  if (item.coverage === undefined) return true;
  return Array.isArray(item.coverage) && item.coverage.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const range = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(range.chunk) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return false;
    if (typeof range.status !== "string" || !STATUSES.has(range.status)) return false;
    return range.status === "unread" ? typeof range.reason === "string" && UNREAD_REASONS.has(range.reason) : range.reason === undefined;
  });
}
