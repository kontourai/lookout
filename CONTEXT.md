# Lookout Context

Lookout is `@kontourai/lookout`, a source registry and drift-check runner built
on Forage snapshots. Given a registry of sources and a snapshot store, it
answers whether a source drifted, can deterministically compare caller-produced
proposal observations, and emits that comparison as neutral, typed drift in its
own vocabulary. It composes Forage for fetch and snapshots, Traverse for
schema/proposal types, and depends on
nothing in the trust layer — its events are already
[Hachure](https://github.com/hachure-org/spec)-evidence-shaped (Hachure is the
open, product-neutral trust-record spec Surface's TrustBundle implements), but
lifting them into a Hachure `TrustBundle` (via `@kontourai/surface`'s
`TrustBundleBuilder`) is a consumer/product responsibility, not Lookout's.
Extraction implementations, Surface projection, authority policy, notification,
and scheduling remain external. Public operational entrypoints return typed
results rather than throwing.

## Term Glossary

- **Source** (`LookoutSource`): a caller-owned description of one monitored
  target — its `id`, `kind` (`web-page` | `api-record` | `structured-file`), an
  absolute HTTP(S) `url`, and a `cadenceHint`. Web/API sources also carry a
  Traverse `TargetFieldSchema[]` plus inert `renderPolicy`; structured files
  instead declare `format` (`yaml` | `json` | `csv`). Lookout retains their raw
  bytes but does not parse or normalize them.
- **Registry** (`LookoutRegistry`): the loaded, validated set of sources from a
  versioned `{ version: 1, sources: [...] }` JSON document (default
  `<cwd>/lookout.sources.json`). Provides exact-id lookup (`get`) and a stable
  file-order `list`; it never merges, discovers, or fetches. Validation reports
  every deterministic issue at once and never reads the network.
- **Render Policy** (`renderPolicy`): `never` | `on-shell-warning` | `always`,
  validated registry data that is **inert at L1** — it is never translated into a
  Forage fetch/render policy. Render wiring remains deferred.
- **Check**: one drift observation for a source. Its exact order is: read the
  prior snapshot → `fetchSource` with `revalidate: true` against the same store →
  validate the dependency result → classify → persist the fresh snapshot before
  reporting success → emit provenance. Lookout owns the prior-vs-fresh `bodyHash`
  comparison; Forage computes a fresh hash and only reads the store.
- **Snapshot Reference** (`snapshotRef` / `priorSnapshotRef` /
  `currentSnapshotRef`): a portable logical ref from Forage's
  `buildSnapshotSourceRef`, never a filesystem path. `unchanged-304` carries one
  ref; fresh comparisons carry both prior and current refs.
- **Check Result** (`CheckResult`): the discriminated result of a check — exactly
  one of four kinds, each carrying `sourceId`, registered `sourceUrl`,
  `checkedAt`, and Forage fetch warnings:
  - **`unchanged-304`**: a validator-backed conditional request returned `304`;
    the prior snapshot was re-served with zero body transfer and is not
    re-persisted. Trustworthy only with Forage's validator-scoped revalidation.
  - **`unchanged-hash`**: a full body was fetched, but its sha256
    `bodyHash` equals the prior snapshot's — no drift, established by L1's own
    comparison. A byte-identical repeat of the prior capture is not persisted
    again; both refs then name the stored capture.
  - **`changed`**: the fresh body was persisted and differs from the prior
    (`changeBasis: "hash"`), or it is the **first successful observation**
    (`changeBasis: "initial"` with a null prior ref).
  - **`error`**: an operational failure, contained so the runner never rejects —
    `origin: "forage"` preserving a Forage `FetchError` discriminant, or
    `origin: "lookout"` with a typed kind (`prior-read` | `persistence` |
    `history-full` | `dependency-contract` | `unexpected`).
- **Snapshot Store** (`createLookoutSnapshotStore`): a thin wrapper over
  Forage's filesystem snapshot store, rooted by default at
  `<cwd>/.kontourai/lookout/snapshots` with an injectable root and an optional
  `maxHistoryFiles` passed to Forage. Lookout adds no custom filenames or
  storage format. Optional check-runner **retention** (`keepLast` plus a
  caller-supplied `cited` set) prunes through Forage's `prune` after each
  stored capture and never removes the latest, the result's prior, or a cited
  snapshot. `resolveLookoutSnapshot`
  resolves and authenticates one exact durable reference offline through this
  store boundary.
- **Provider Resolver** (`ProviderResolver`): a Datum `resolve` capability
  threaded into the runner for L2. L1 accepts it but **never invokes it** —
  resolving would materialize secrets for no purpose this slice.
- **Proposal Observation Store** (`ObservationStore`): Lookout-owned,
  digest-addressed proposal continuity under
  `<cwd>/.kontourai/lookout/observations`. It validates same-source snapshot and
  check anchors, atomically advances one per-source pointer, and retains the two
  newest valid committed observations. Missing means first run; corruption is a
  typed error and never an empty baseline.
- **Drift emission** (`DriftEmitter`): compares a genuine stored prior with a
  current caller-produced proposal observation and emits one neutral
  `DriftFact`/`ProposalDiffEvent` set per comparison — `events`, `facts`, and a
  `priorObservationId` (`null` on the first-ever observation). When the current
  proposal set is marked `incomplete` (its extraction did not read all of its
  text), nothing the prior had is reported as removed: those proposals and
  entities are `unobserved`, and the fact carries the `incomplete` marker. An
  incomplete run whose loss might not recur never replaces an existing baseline
  (`committedObservation: null`); one whose every loss recurs (a cap), or a
  first observation, is stored with its marker, and what a later run adds
  against it is `newlyObserved`, not added, unless the emitter's optional
  `priorText` preparation rebuilds and verifies the prior's full prepared text
  and none of the entity's exact excerpts occur in it (**Prior Text
  Anchoring**); the fact's `priorText` says whether that text was `verified` or
  why it was `unavailable`. An occurrence paired with a field occurrence the
  incomplete prior did read is never newly observed: if it moved or changed,
  the provenance change or field-changed event describes it and the
  occurrence is added. Newly observed proposals are reviewable as
  `proposal-newly-observed` semantic review work. Registry kind supplies fact `origin`; resolution is always `observation`. First observation
  produces a `baseline-established` fact, no events, and a null
  `priorObservationId`.
- **Observe-extract-diff composition** (`createObserveExtractDiff`): an
  additive, injected acquisition/extraction/recording composition. It records
  `unchanged-304` and `unchanged-hash` observations without calling extraction
  when the capture matches the recorder's last extracted snapshot (same URL and
  body hash); therefore no preparation or provider work occurs for unchanged
  sources. An unchanged capture that was never extracted is extracted instead. A
  changed source retains its registered identity, prior/current snapshot refs,
  Traverse prepared-artifact identity, proposal-set observation, compact
  attempt record, and recorder-provided observation identities. Traverse's
  typed partial completion, provider failures, and mixed partial/failure runs
  remain distinct outcomes. Durable failure details are reduced to neutral
  classifications without provider names, messages, native diagnostics, or
  free-form extraction warnings; a
  first observation has a null prior identity and no fabricated comparison.
- **Semantic review work** (`buildSemanticReviewWork`): a pure projection of
  one genuine prior/current proposal transition into structurally
  Survey-compatible `ReviewItem` resources. Added, removed, moved, and
  value-changed and provenance-changed proposals are distinct; newly introduced declared-field
  coverage gaps and exact-provenance gaps are explicit. One field change is one
  item: a value change that also moved is a single value-changed item with both
  locators. Provenance equality is the resolved occurrence, not how the
  resolver was steered to it (`occurrence.selection`, `hintUsed`), and an equal
  value at the same offsets inside a re-cut excerpt is an
  `excerptBoundaryChanges` fact, not work. Every item binds both
  observation identities and preserves each available side's source snapshot,
  locator, excerpt, extractor, and observation time. An absent side remains a
  reviewable source-version candidate anchored to that observation's snapshot.
  Stable proposal sets emit no work, and deterministic transition/item
  identities make replay idempotent. Lookout imports no review package at
  runtime and chooses no resolution, escalation, or authority policy.
- **Consumer projection**: lifting emitted drift events into a Hachure
  `TrustBundle` (via `@kontourai/surface`'s `TrustBundleBuilder`) is a
  consumer/product responsibility. Lookout imports nothing from the trust layer
  and chooses no review, supersession, precedence, or carry-forward policy.

## Boundary

Lookout owns the registry, drift classification, deterministic proposal diff,
proposal-observation continuity, neutral drift emission, semantic review-work
shaping, injected
observe-extract branching, and JSONL commands. Forage owns fetching, snapshot
storage, and durable reference integrity; Traverse owns extraction. Trust-bundle authoring,
Surface projection, notification, crawling, review/authority policy, and
scheduling remain external.
