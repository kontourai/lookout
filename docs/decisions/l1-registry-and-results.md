---
status: current
subject: L1 source registry, drift classification, and result contract
decided: 2026-07-10
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/1
  - kind: doc
    ref: CONTEXT.md
  - kind: url
    ref: https://github.com/kontourai/traverse/issues/49
---
# L1 source registry, drift classification, and result contract

## Decision

Lookout L1 is a source registry plus a non-throwing drift-check runner over
Traverse snapshots. The decisions that shape the observable contract:

- **Versioned JSON registry.** Sources live in a `{ version: 1, sources: [...] }`
  document (default `<cwd>/lookout.sources.json`, overridable by library path or
  CLI `--registry`). No YAML dependency. Each `LookoutSource` carries `id`,
  `kind` (`web-page` | `api-record`), an absolute HTTP(S) `url`, a Traverse
  `TargetFieldSchema[]` `targetSchema`, a `cadenceHint`, and a `renderPolicy`.
  Validation reports every deterministic issue at once with index/id context and
  never touches the network.

- **Four result kinds.** A check classifies into exactly one of `unchanged-304`,
  `unchanged-hash`, `changed`, or `error`. There is no fifth "initial" variant:
  the **first successful observation is `changed` with `changeBasis: "initial"`
  and a null prior ref**, which keeps the union closed while staying honest that
  nothing preceded it.

- **L1 owns comparison and persistence.** Traverse's `fetchSource` only reads the
  store and computes a fresh `bodyHash`; it never persists a fresh 200 and never
  compares hashes. L1's exact order per source is: load the prior snapshot →
  `fetchSource({ ..., revalidate: true }, { store })` → validate the dependency
  result → classify → persist the fresh snapshot → emit. A `304` re-serves the
  prior snapshot marked `notModified`/`fromCache` and is **not** re-persisted
  (persisting it would fabricate a fresh capture; `checkedAt` belongs to the
  result, not a rewritten snapshot). `unchanged-hash` and `changed` come from
  L1's own sha256 `bodyHash` comparison of prior vs. fresh.

- **Store before emit.** A successful `changed`/`unchanged-hash` result is only
  returned after the required `store.put` resolves, so every emitted provenance
  ref is replayable.

- **Logical snapshot refs, never paths.** Provenance uses Traverse's
  `buildSnapshotSourceRef` (`unchanged-304` carries one ref; fresh comparisons
  carry both prior and current refs). Paths are never exposed.

- **The runner never throws (R2).** Operational failures become typed results,
  not exceptions: a Traverse `FetchError` is preserved with its discriminant
  under `origin: "traverse"`; a rejected store read/write, a throwing injected
  fetch, a malformed dependency result, or any unexpected exception becomes an
  `origin: "lookout"` error (`prior-read` | `persistence` | `dependency-contract`
  | `unexpected`). `checkAll` runs sources sequentially, returns one ordered
  result per source, and continues past errors.

- **JSONL CLI, external scheduling.** `lookout check <id>` and
  `lookout check --all` emit exactly one compact JSON object per checked source
  per stdout line, in registry order; human/fatal diagnostics go to stderr. Exit
  is `0` whenever the requested checks were attempted (including per-source
  `error` results); non-zero only when an invocation/registry failure prevents
  producing the requested result set. Cadence/scheduling stays external (boo).

- **Inert render policy.** `renderPolicy` is validated registry data this slice;
  L1 never translates it (or `kind`) into a fetch/render policy and never adds
  retries/robots/redirects — those remain Traverse's. Render wiring waits on
  traverse#50.

- **Traverse pin gate.** Trustworthy `unchanged-304` requires the validator
  scoping fix from traverse#49; L1 exact-pins `@kontourai/traverse@0.14.1` (the
  first release containing it). `>= 0.14.1` is the documented floor.

## Boundary

L1 stores `targetSchema` but performs no extraction, projection, semantic
diffing, event emission, notification, crawling, retention, or review policy —
those are later slices. A Datum provider-resolver capability is threaded for L2
but never invoked in L1 (resolving would materialize secrets for no purpose).
