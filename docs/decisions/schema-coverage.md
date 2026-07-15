---
status: current
subject: Static schema-coverage drift check
decided: 2026-07-14
evidence:
  - kind: doc
    ref: README.md
  - kind: doc
    ref: src/coverage.ts
---
# Static schema-coverage drift check

## Decision

Lookout exposes a static coverage check, `checkSchemaCoverage(schema,
proposals)`, that reduces one declared `TargetFieldSchema[]` and one produced
`ExtractionProposal[]` set into `{ covered, gaps }`: the declared paths at least
one proposal produced, and the declared paths that produced none. Each gap
carries the schema field's own `required` flag so a consumer can escalate a
missing required field harder than a missing optional one.

This is the static complement to the temporal proposal diff. `diffProposalSets`
answers "did the produced proposals change since we last looked?" and, by
construction, is silent on a first observation. Coverage answers a question that
has an answer on the very first look and needs no prior: did the source drift —
reformat, rename a heading, reorder a table — such that a field the schema
*declares* silently stopped being produced? A declared field with no proposal is
exactly that layout-drift signal, which otherwise surfaces only as a silent gap
in downstream output.

Membership is by exact `proposal.fieldPath === field.path`. The check measures
the produced set the caller supplies; it does not itself run any
post-verification survivor filtering. A field the extractor produced but a
downstream step later dropped is explained by that step's own diagnostic and is
not a coverage gap — the extractor covered it. A caller that wants coverage
measured against a post-verification set passes that set as `proposals`.

The check is pure and total: no injected callbacks, no network, no persistence,
no throw. Declared fields are evaluated in schema order, and a schema that
repeats a `path` reports it once per occurrence — declared-field uniqueness is
the schema's concern, not this check's. It reports only against the *declared*
surface; a proposal whose `fieldPath` is absent from the schema is neither
covered nor a gap (unexpected-field detection is a separate, deferred concern).

## Boundary

The coverage check owns the static declared-vs-produced reduction and the
required-field flag pass-through. Consumers own how a gap is surfaced or
escalated (warning, review item, hard failure), any temporal "coverage regressed
since last observation" interpretation built by comparing successive coverage
results, extraction itself, and the choice of which produced-proposal set to
measure.
