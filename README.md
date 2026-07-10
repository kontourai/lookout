# @kontourai/lookout

A small **source registry** and **non-throwing drift-check runner** built on
[Traverse](https://github.com/kontourai/traverse) snapshots. Lookout answers one
question per registered source, cheaply and honestly: *did this source change
since we last looked?*

It composes Traverse for fetching and snapshot storage, provides deterministic
proposal diffing, and authors provenance-bearing Survey inputs. It does **not**
extract fields, project to Surface, review claims, notify, crawl, or schedule.
Operational failures are returned as typed results.

## Requirements

- Node.js `>= 22`.
- `@kontourai/traverse` `>= 0.14.1`. This is a hard floor, not a preference:
  trustworthy `unchanged-304` classification depends on the validator-scoping fix
  from [traverse#49](https://github.com/kontourai/traverse/issues/49), first
  released in `0.14.1`. Lookout exact-pins `0.14.1`. On an earlier Traverse a
  conditional request could reuse a prior snapshot's validators against a
  different URL and report a **false** `304`, so do not downgrade.

## Registry

Sources live in a versioned JSON document (default `<cwd>/lookout.sources.json`;
override with the library path argument or the CLI `--registry` flag):

```json
{
  "version": 1,
  "sources": [
    {
      "id": "docs-home",
      "kind": "web-page",
      "url": "https://example.com/docs",
      "targetSchema": [{ "path": "title", "type": "string", "required": true }],
      "cadenceHint": "daily",
      "renderPolicy": "never"
    }
  ]
}
```

Fields per source:

| Field | Meaning |
| --- | --- |
| `id` | Non-empty, unique within the document. Used for exact lookup and snapshot identity. |
| `kind` | `web-page` or `api-record`. |
| `url` | Absolute HTTP(S) URL. |
| `targetSchema` | Traverse `TargetFieldSchema[]`. Stored inert at L1 (no extraction yet). |
| `cadenceHint` | Non-empty string; advisory only — Lookout does not schedule. |
| `renderPolicy` | `never` \| `on-shell-warning` \| `always`. **Inert** at L1 (never mapped to a fetch/render policy). |

Validation reports **every** deterministic issue at once (with index/id context)
and never reads the network. Lookup is exact-id; listing preserves file order —
no merging, discovery, or remote registries.

## Check results

A check classifies each source into exactly one of four kinds. Every result
carries `sourceId`, the registered `sourceUrl`, `checkedAt`, and Traverse
`warnings`.

| `kind` | When | Extra fields |
| --- | --- | --- |
| `unchanged-304` | A validator-backed conditional request returned `304`; zero body transfer; the prior snapshot is not re-persisted. | `snapshotRef` |
| `unchanged-hash` | A full body was fetched and persisted, but its sha256 `bodyHash` equals the prior, **and** it came from the same resource URL — established by Lookout's own comparison. | `priorSnapshotRef`, `currentSnapshotRef` |
| `changed` | The fresh body differs from the prior (`changeBasis: "hash"`), **or** it is the first successful observation (`changeBasis: "initial"`, `priorSnapshotRef: null`). | `priorSnapshotRef` (nullable), `currentSnapshotRef`, `changeBasis` |
| `error` | Any operational failure — contained so the runner never rejects. | `origin` (`traverse` \| `lookout`), `error` |

`unchanged-hash` asserts same-resource continuity, so it requires **both** an
identical `bodyHash` **and** the same resource URL as the prior snapshot. If a
source has moved — the prior snapshot's URL differs from this fetch's — the
result is `changed` even when the bytes are byte-identical, and the fresh
snapshot is persisted as the new baseline. (The `unchanged-304` path is already
resource-scoped by Traverse's validators, so only the hash path needs this
guard.)

`error` results preserve provenance: `origin: "traverse"` carries Traverse's
discriminated `FetchError` verbatim (its `kind`, and `status` when present);
`origin: "lookout"` carries a typed `kind` — `prior-read`, `persistence`,
`dependency-contract`, or `unexpected`.

Snapshot references (`snapshotRef` / `priorSnapshotRef` / `currentSnapshotRef`)
are portable logical refs from Traverse's `buildSnapshotSourceRef` — never
filesystem paths. Snapshots are stored via Traverse's filesystem store, rooted by
default at `<cwd>/.kontourai/lookout/snapshots` (override with the CLI
`--snapshot-root` flag or by injecting a store in library use). Lookout adds no
custom filenames or retention.

## CLI

```
lookout check <id> [--registry <path>] [--snapshot-root <path>]
lookout check --all [--registry <path>] [--snapshot-root <path>]
lookout emit-survey <id> --observation <path|-> [--registry <path>] [--observation-root <path>]
```

- Emits **exactly one compact JSON object per checked source, per stdout line**
  (JSON Lines), in registry order. Snapshot bodies and resolved secrets are never
  serialized. Human/fatal diagnostics go to stderr.
- `<id>` and `--all` are mutually exclusive.
- **Exit codes:** `0` when the requested checks were attempted — *including*
  per-source `error` results (a network failure on one source is a normal,
  emitted result, not a CLI failure). Non-zero only when an invocation or
  registry problem prevents producing the requested result set at all (unknown
  id, invalid arguments, or an unreadable/invalid registry).

This exit/output contract is what makes `lookout check --all` safe to drive from
an external scheduler.

`emit-survey` is a separate composable command: its input is a JSON object with
`observation` (a `ProposalSetObservation`) and its matching `check` anchor.
Extraction is supplied by the caller. The first successful input commits a
baseline fact and returns `surveyInput: null`; a genuine later change returns
one unreviewed SurveyInput batch. State defaults to
`.kontourai/lookout/observations`, uses immutable digest-addressed records and
an atomic per-source pointer, and retains the latest two valid observations.
Consumers pass the batch to Survey when they want Surface projection.
Store paths refuse symbolic links. An existing source lock is not automatically
broken: after confirming no writer is active, an operator may remove an
abandoned `.lock` file and retry.

## Library

```ts
import {
  loadRegistry,
  createCheckRunner,
  createLookoutSnapshotStore,
} from "@kontourai/lookout";

const registry = await loadRegistry(); // <cwd>/lookout.sources.json
const runner = createCheckRunner({ store: createLookoutSnapshotStore() });
const results = await runner.checkAll(registry.list());
```

`createCheckRunner` accepts injected seams — `store`, `fetchSource` (defaults to
Traverse), `fetchOptions`, and `clock` — so checks run with no live network or
timers in tests.

## Non-goals

Extraction, Surface projection, notifications, crawling, review/escalation or
authority policy, rendered-fetch wiring
(`renderPolicy` is inert pending traverse#50), and scheduling. Traverse retains
all fetch politeness, robots, redirects, retries, timeouts, headers, user-agent,
and rendered-fetch behavior.

## Development

```sh
npm ci
npm run verify   # content-boundary + decisions + typecheck + test + pack sanity
```

Individual gates: `npm test`, `npm run typecheck`, `npm run check:pack`,
`npm run check:decisions`, `npm run check:content-boundary`.

## License

Apache-2.0.
