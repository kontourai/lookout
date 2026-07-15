import type { ExtractionProposal, TargetFieldSchema } from "@kontourai/traverse";

/**
 * A declared schema field that the supplied observation did not cover: the
 * extractor produced **zero** proposals whose `fieldPath` equals this field's
 * declared `path`. `required` mirrors the schema field's own `required` flag
 * (absent → `false`) so a consumer can escalate a missing required field harder
 * than a missing optional one.
 */
export interface SchemaCoverageGap {
  readonly fieldPath: string;
  readonly required: boolean;
}

/**
 * The result of checking one extraction observation against the declared
 * schema. `covered` lists, in schema order, every declared `path` that at least
 * one proposal produced; `gaps` lists, in schema order, every declared `path`
 * that produced none. The two are disjoint and together cover the declared
 * schema. `gaps` never mentions a proposal fieldPath that is absent from the
 * schema — this is a coverage check of the *declared* surface, not an
 * unexpected-field detector.
 */
export interface SchemaCoverageResult {
  readonly covered: readonly string[];
  readonly gaps: readonly SchemaCoverageGap[];
}

/**
 * Static schema-coverage check: which declared schema fields did this single
 * extraction observation fail to produce at all?
 *
 * This is the *static*, first-observation-capable complement to the temporal
 * proposal diff (`diffProposalSets`). The diff answers "did the produced
 * proposals change since we last looked?" and, by construction, says nothing on
 * a first observation. Coverage answers a question that has an answer on the
 * very first look and needs no prior: "did the source drift — reformat, rename a
 * heading, reorder a table — such that a field the schema *declares* silently
 * stopped being produced?". A declared field with no proposal is exactly that
 * signal: a layout-drift regression that would otherwise surface only as a
 * silent gap in the output.
 *
 * Membership is by exact `proposal.fieldPath === field.path`. Matching against
 * the produced-proposal set (not any post-verification survivor set) is
 * deliberate: a field the extractor *did* produce but a downstream step later
 * dropped is explained by that step's own diagnostic and is not a coverage gap
 * — the extractor covered it. Callers that want coverage measured against a
 * post-verification set simply pass that set as `proposals`.
 *
 * Pure and total: no injected callbacks, no network, no throw. Declared fields
 * are evaluated in schema order; a schema that repeats a `path` reports it once
 * per occurrence (the schema, not this check, owns declared-field uniqueness).
 */
export function checkSchemaCoverage(
  schema: readonly TargetFieldSchema[],
  proposals: readonly ExtractionProposal[],
): SchemaCoverageResult {
  const producedPaths = new Set(proposals.map((proposal) => proposal.fieldPath));
  const covered: string[] = [];
  const gaps: SchemaCoverageGap[] = [];
  for (const field of schema) {
    if (producedPaths.has(field.path)) {
      covered.push(field.path);
    } else {
      gaps.push({ fieldPath: field.path, required: field.required === true });
    }
  }
  return { covered, gaps };
}
