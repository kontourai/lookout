---
status: current
subject: L3 neutral drift emission and trust-layer independence
decided: 2026-07-14
evidence:
  - kind: doc
    ref: README.md
  - kind: doc
    ref: src/drift-emission.ts
---
# L3 neutral drift emission and trust-layer independence

## Decision

Lookout emits neutral, typed drift in its own vocabulary and depends on
**nothing** in the trust layer — neither the `@kontourai/surface` foundation nor
any product built on it (including `@kontourai/survey`). `createDriftEmitter`
replaces the prior `SurveyEmitter`: its `DriftResult` carries `events`,
`facts`, and a `priorObservationId` (`null` on the first-ever observation, set
on every later genuine comparison), with no `surveyInput` field and no
authored trust-bundle record of any kind.

Every `ProposalEvidence` still carries `snapshotRef` / `locator` / `excerpt` /
`extractor` / `fieldPath`, so emitted events remain Hachure-evidence-shaped —
they map one-to-one onto a Hachure evidence record — but that shape is a
convenience for whoever consumes them, not a dependency Lookout takes on.
Lifting `DriftResult` events into a Hachure `TrustBundle` is the consumer's or
product's job, done with `@kontourai/surface`'s `TrustBundleBuilder`. Lookout
authors no claims, review outcomes, or provenance-resolution policy, and
imports no type or value from `@kontourai/survey` or `@kontourai/surface`.

The rationale mirrors the L2 precedent set by Traverse's `ExtractionProposal`:
a building block's output can be trust-format-**aware** in shape (so a
consumer's mapping is cheap and mechanical) while remaining
trust-format-**independent** in dependencies (so the building block itself
never couples to, exact-pins, or breaks on a product's release cadence).
Traverse's proposals already matched Survey's shape without importing survey;
Lookout's drift events now do the same for Hachure/Surface.

The CLI command renamed from `emit-survey` to `emit-drift` accordingly, with
matching option/error-message renames (`emitSurvey` → `emitDrift`), but its I/O
contract — one compact JSON object per stdout line, exit codes, bounded
`--observation <path|->` / `--observation-root` reading, stderr diagnostics —
is unchanged.

## Boundary

Lookout owns deterministic prior/current derivation, observation continuity,
facts, and neutral event emission. Callers own proposal extraction and
identity callbacks. A consumer or product owns lifting `DriftResult` events
into a Hachure `TrustBundle` via `@kontourai/surface`'s `TrustBundleBuilder`,
and owns all review, supersession, precedence, and carry-forward policy.
