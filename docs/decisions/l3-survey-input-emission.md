---
status: superseded
subject: L3 provenance-bearing SurveyInput emission and observation continuity
decided: 2026-07-10
superseded_by: neutral-drift-emission
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/3
  - kind: doc
    ref: CONTEXT.md
---
# L3 provenance-bearing SurveyInput emission and observation continuity

## Decision

Lookout authors Survey `SurveyInput` batches but does not project them to
Surface. Consumers own projection, review, persistence, and policy. Each L2
event becomes one proposed claim in the generic `lookout.*` vocabulary. Its
origin is copied from the registered source kind, its resolution is exactly
`observation`, and authorization is absent: Lookout creates no review outcome.
It never authors testimony, supersession, precedence selection, carry forward,
or test-output evidence.

Proposal observations live in a Lookout-owned sibling store at
`.kontourai/lookout/observations`; Traverse snapshots remain separately owned at
`.kontourai/lookout/snapshots`. Records are immutable and digest addressed. A
per-source `latest.json` pointer advances atomically under an exclusive lock,
and the two newest valid committed records are retained. Schema, digest,
source, snapshot, and check-anchor continuity are validated on read. Corrupt
state is a typed error, never a missing-prior fallback. Pre-commit failures do
not advance the pointer; post-commit pruning failures become warnings.
Record and pointer renames are followed by a directory fsync. Observation root,
source, record, pointer, and lock paths refuse symbolic links. Lock existence is
reported as a continuity conflict; other lock-open failures are I/O errors.
Locks are never automatically broken because this format has no portable proof
that an apparent stale owner is dead. Operator inspection/removal is the
conservative recovery path for an abandoned lock.

The first valid observation establishes and commits a provenance-bearing
baseline fact without calling the two-observation diff, emitting events, or
building a SurveyInput. Every later derivation uses only a digest-valid genuine
prior loaded from the store. Removed entities remain facts; a prior-only field
removal claim is anchored to the current snapshot while preserving its prior
evidence metadata.

`lookout emit-survey` is separate from `lookout check`. It consumes a caller-
produced proposal observation from a file or stdin and returns one JSONL
emission result. This preserves the existing check stream and keeps extraction
orchestration explicit. `@kontourai/survey` is exact-pinned to `1.7.0`, the
published release containing the required provenance contract;
`@kontourai/traverse` remains exact-pinned to `0.14.1`.

## Boundary

Lookout owns deterministic prior/current derivation, observation continuity,
facts, and unreviewed SurveyInput authoring. Callers own proposal extraction and
identity callbacks. Survey owns its record builder and projection contract;
consumers own Surface projection and authority policy.
