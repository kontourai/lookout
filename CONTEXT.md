# Lookout Context

Lookout is `@kontourai/lookout`, a source registry and drift-check runner built
on Traverse snapshots. Given a registry of sources and a snapshot store, it
answers whether a source drifted, can deterministically compare caller-produced
proposal observations, and can author unreviewed Survey inputs. It composes
Traverse for fetch and snapshots and Survey for record authoring. Extraction,
Surface projection, authority policy, notification, and scheduling remain
external. Public operational entrypoints return typed results rather than
throwing.

## Term Glossary

- **Source** (`LookoutSource`): a caller-owned description of one monitored
  target — its `id`, `kind` (`web-page` | `api-record`), an absolute HTTP(S)
  `url`, a Traverse `TargetFieldSchema[]` `targetSchema` (stored inert at L1; no
  extraction yet), a `cadenceHint`, and a `renderPolicy`. Lookout defines no
  domain field names itself; the schema is 100% caller-supplied, so no domain
  vocabulary lives in this package.
- **Registry** (`LookoutRegistry`): the loaded, validated set of sources from a
  versioned `{ version: 1, sources: [...] }` JSON document (default
  `<cwd>/lookout.sources.json`). Provides exact-id lookup (`get`) and a stable
  file-order `list`; it never merges, discovers, or fetches. Validation reports
  every deterministic issue at once and never reads the network.
- **Render Policy** (`renderPolicy`): `never` | `on-shell-warning` | `always`,
  validated registry data that is **inert at L1** — it is never translated into a
  Traverse fetch/render policy. Render wiring is deferred (traverse#50).
- **Check**: one drift observation for a source. Its exact order is: read the
  prior snapshot → `fetchSource` with `revalidate: true` against the same store →
  validate the dependency result → classify → persist the fresh snapshot before
  reporting success → emit provenance. Lookout owns the prior-vs-fresh `bodyHash`
  comparison; Traverse only computes a fresh hash and only reads the store.
- **Snapshot Reference** (`snapshotRef` / `priorSnapshotRef` /
  `currentSnapshotRef`): a portable logical ref from Traverse's
  `buildSnapshotSourceRef`, never a filesystem path. `unchanged-304` carries one
  ref; fresh comparisons carry both prior and current refs.
- **Check Result** (`CheckResult`): the discriminated result of a check — exactly
  one of four kinds, each carrying `sourceId`, registered `sourceUrl`,
  `checkedAt`, and Traverse `warnings`:
  - **`unchanged-304`**: a validator-backed conditional request returned `304`;
    the prior snapshot was re-served with zero body transfer and is not
    re-persisted. Trustworthy only with the traverse#49 validator-scoping fix
    (`@kontourai/traverse` `>= 0.14.1`).
  - **`unchanged-hash`**: a full body was fetched and persisted, but its sha256
    `bodyHash` equals the prior snapshot's — no drift, established by L1's own
    comparison.
  - **`changed`**: the fresh body was persisted and differs from the prior
    (`changeBasis: "hash"`), or it is the **first successful observation**
    (`changeBasis: "initial"` with a null prior ref).
  - **`error`**: an operational failure, contained so the runner never rejects —
    `origin: "traverse"` preserving a Traverse `FetchError` discriminant, or
    `origin: "lookout"` with a typed kind (`prior-read` | `persistence` |
    `dependency-contract` | `unexpected`).
- **Snapshot Store** (`createLookoutSnapshotStore`): a thin wrapper over
  Traverse's filesystem snapshot store, rooted by default at
  `<cwd>/.kontourai/lookout/snapshots` with an injectable root. Lookout adds no
  custom filenames, retention, or storage policy.
- **Provider Resolver** (`ProviderResolver`): a Datum `resolve` capability
  threaded into the runner for L2. L1 accepts it but **never invokes it** —
  resolving would materialize secrets for no purpose this slice.
- **Proposal Observation Store** (`ObservationStore`): Lookout-owned,
  digest-addressed proposal continuity under
  `<cwd>/.kontourai/lookout/observations`. It validates same-source snapshot and
  check anchors, atomically advances one per-source pointer, and retains the two
  newest valid committed observations. Missing means first run; corruption is a
  typed error and never an empty baseline.
- **Survey emission** (`SurveyEmitter`): compares a genuine stored prior with a
  current caller-produced proposal observation and authors one proposed Survey
  claim per L2 event. Registry kind supplies origin, resolution is always
  `observation`, and authorization is absent. First observation produces a
  baseline fact, no events, and no SurveyInput.
- **Consumer projection**: passing an authored SurveyInput to Survey's Surface
  projection API is a consumer responsibility. Lookout neither imports Surface
  nor chooses review, supersession, precedence, or carry-forward policy.

## Boundary

Lookout owns the registry, drift classification, deterministic proposal diff,
proposal-observation continuity, unreviewed SurveyInput authoring, and JSONL
commands. Traverse owns fetching and snapshots. Survey owns its input builder
and projection contract. Extraction, Surface projection, notification,
crawling, review/authority policy, and scheduling remain external.
