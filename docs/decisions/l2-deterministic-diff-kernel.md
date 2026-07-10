---
status: current
subject: L2 deterministic diff kernel and proposal-set events
decided: 2026-07-10
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/2
  - kind: doc
    ref: CONTEXT.md
---
# L2 deterministic diff kernel and proposal-set events

## Decision

Lookout L2 has two public API layers. A generic deterministic kernel provides
recursive canonical value keys, structural comparison, and caller-keyed
multiset facts. Proposal-set composition is built on that kernel and reduces
two supplied observations into typed facts and events. The composition layer
does not duplicate or bypass the generic mechanics.

Identity remains caller-owned. The canonical encoder supplies collision-safe
mechanics, not a universal domain identity. Entity selection, entity identity,
and semantic field-slot identity are mandatory caller callbacks. Exact proposal
occurrence identity is a separate helper derived from normalized field path,
path indices, and verified locator. It must not be used as a default entity
identity because layout can move while an entity remains the same. Duplicate
identities are legal multiset occurrences and retain stable counts and order.

Canonical values use recursive type tags. The encoding distinguishes missing
properties, `undefined`, `null`, non-finite numbers, negative zero, array holes,
strings, booleans, bigint, arrays, and plain objects while normalizing object-key
order recursively. Symbols, functions, cycles, and exotic object instances
produce typed errors and never escape as thrown exceptions. Callers normalize
domain wrappers into primitives before encoding.

L2 v1 is deterministic-only. It compares already-produced proposal observation
envelopes and performs no provider resolution, extraction, rendering, fetching,
persistence, notification, truth resolution, confidence thresholding,
suppression, or review-mode selection. Datum's provider seam stays reserved for
later extraction orchestration.

The v1 event vocabulary is deliberately closed to `new-entity-appeared` and
`field-changed`. A field change distinguishes population, update, additions,
removals, and replacement while carrying the available evidence from both
observation sides. Exact retained proposal occurrences, additions, removals,
equal values with moved provenance, and removed entities remain structural
facts. `entity-changed` is derivable and therefore deferred;
`entity-disappeared` is unsafe without completeness evidence; and
`anticipated-value-arrived` requires caller policy beyond deterministic
absent-to-present comparison.

Observation source ids must match. Every public entrypoint contains callback
exceptions and unsupported values as discriminated typed errors. Event and fact
ordering is deterministic and follows stable caller input order.

## Boundary

L2 owns deterministic encoding, comparison, multiset accounting, proposal
occurrence continuity, provenance facts, and the two-event reduction. Consumers
own domain projections and identities, completeness interpretation, confidence
and suppression policy, review modes, persistence, and downstream event use.
