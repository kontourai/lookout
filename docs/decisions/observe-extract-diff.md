---
status: current
subject: Observe-extract-diff composition and typed extraction outcomes
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/23
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/63
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/64
  - kind: doc
    ref: src/observe-extract-diff.ts
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/86
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/89
---
# Observe-extract-diff composition and typed extraction outcomes

## Decision

`createObserveExtractDiff` is an additive composition entrypoint. It accepts
three injected capabilities (acquisition, extraction, and observation recording)
and the snapshot store acquisition persists to.
Lookout supplies none of their implementations. In particular, it does not
resolve a source snapshot, prepare content, select a provider, or persist an
external caller's observation format.

The composition calls acquisition first. A typed acquisition error is recorded
as an `acquisition-error` observation. `unchanged-304` and `unchanged-hash`
each record an `unchanged` observation and make zero extraction calls when the
capture has the same URL, body hash, and text decoding as the recorder's
`lastExtractedSnapshotRef`. A reference does not name the charset its text was
decoded with, so the composition takes the snapshot store acquisition persists
to (`snapshots`) and resolves both references; an unresolvable one counts as a
different capture and is extracted. This means unchanged sources make zero preparation
and provider calls: the only code that could do either is behind the extraction
capability, which is not invoked.

"Unchanged" is relative to the latest stored capture, and acquisition stores a
capture before extraction runs (extraction resolves it by reference). A capture
whose extraction failed is therefore already the baseline on the next check. So
the composition asks the recorder for the last snapshot an observation fully
handled (`extractedSnapshotRef`: the current snapshot of a `completed`,
`partial`, or `unchanged` observation). When the unchanged capture differs from
it, or there is none, the capture is extracted against that baseline rather
than reported as unchanged (kontourai/lookout#86).

For a `changed` check, the extraction capability receives the registered source
and the immutable current snapshot reference. Its Traverse result is reduced to
an observation that retains the source identity, prior/current snapshot
references, prepared-artifact identity, proposal-set observation, and a compact
attempt record. Raw source bodies and raw provider responses are deliberately
not copied into Lookout's result. The recorder returns current and prior
observation identities; continuity storage and policy remain caller-owned.

Traverse's typed `partial` and `providerFailures` fields remain visible as
distinct `partial`, `provider-failure`, and mixed `partial-provider-failure`
outcomes. Durable provider failures contain only neutral `kind` and `retryable`
classifications, never provider identity, message, or native diagnostics. Other
extraction errors, including a thrown injected capability, are
`extraction-failure` observations; a throw has no fabricated timestamp or usage
telemetry.
A first changed observation carries `priorObservationId: null` and its proposal
set only; it does not fabricate additions, removals, events, or a comparison.
Callers that want deterministic proposal-diff events continue to use the
existing `createDriftEmitter` API with that proposal set and their own identity
callbacks.

The exact Traverse prepared-artifact, partial-completion, and provider-failure
contracts are required dependencies of this entrypoint. They are intentionally
represented as public package types rather than copied into Lookout.
Acquisition identity must match the requested registered source, and Traverse's
public validator must accept the prepared artifact with a `sourceSnapshotRef`
equal to the check's current snapshot reference. Recorder output contributes
only observation identities and cannot overwrite the observed payload.

Raw responses, free-form extraction warnings, and thrown/provider diagnostic
text are excluded by default. Proposal excerpts, registered URLs, and
acquisition check warnings can still carry sensitive source content, so
consumers remain responsible for
retention, redaction, and access controls at their recording boundary.

## Boundary

Lookout owns the branch that avoids unnecessary extraction and the neutral
observation envelope. Acquisition, snapshot resolution, content preparation,
provider invocation, durable observation storage, proposal identity policy, and
downstream review or trust projection remain outside the core. Existing
caller-orchestrated check and drift-emission APIs remain unchanged.
