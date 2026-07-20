# @kontourai/lookout

**Cheap, honest drift detection for content you re-check over time — "did this source change since we last looked?"**

A small **source registry** and **non-throwing drift-check runner** built on
[Forage](https://github.com/kontourai/forage) snapshots. It composes Forage for
fetching and snapshot storage, provides deterministic proposal diffing, and
emits neutral, typed drift — its own vocabulary, in its own dependency-free
package. It does **not** implement acquisition or extraction, author trust-layer
records, project to Surface, review claims, notify, crawl, or schedule.
Operational failures are returned as typed results.

## Why it's different

The naive way to answer "did it change?" is to re-crawl the source and diff the
bytes. That's expensive (full re-download every time), noisy (a changed ad or
timestamp reads as "changed"), and fragile (a thrown error mid-run looks the same
as "no change"). Lookout is the opposite on all three:

| | Re-crawl + byte-diff | `lookout` |
|---|---|---|
| Cost | full re-download every check | **conditional `304`** — often no download at all |
| Signal | raw bytes (ads/timestamps = "changed") | **proposal-identity diff** — "a *new entity appeared*" vs "a byte moved" |
| Honesty | a crash or false-`304` silently reads as "unchanged" | **typed results, never throws**; Forage scopes validators to the exact prior resource and Lookout verifies the returned capture identity |
| Output | your problem to shape | **neutral, typed drift** — events already Hachure-evidence-shaped, ready for a consumer to lift into a trust bundle |

So the point isn't "diffing" — it's *cheap + honest + semantic + review-ready*
change detection, so a periodic re-check surfaces **only the real delta** (this
provider is new, that listing changed) instead of re-reviewing everything.

## Where it sits

One layer in a four-verb stack; each repo owns one verb and is usable alone:

- **[forage](https://github.com/kontourai/forage)** — CRAWL: fetch / frontier / SSRF-safe egress / snapshots
- **[traverse](https://github.com/kontourai/traverse)** — EXTRACT: content + schema → reviewable proposals
- **lookout** — CHANGE: did this registered source drift since last look?
- **survey** — the SHAPE: what reviewed truth looks like (claims / review / resolution)

Lookout composes Forage's `/fetch` surface for cheap `304`-aware re-checks,
and Traverse's `ExtractionProposal` identity for the semantic diff. Dependency
arrows point only downward — no cycles. Lookout itself depends on nothing in the
trust layer: its events are already Hachure-evidence-shaped (`snapshotRef` /
`locator` / `excerpt` / `fieldPath`), so a consumer or product lifts them into a
Hachure `TrustBundle` via `@kontourai/surface`'s `TrustBundleBuilder` — the same
pattern Traverse uses to match Survey's shape without importing Survey.

**SSRF-safe egress.** Registered source URLs are operator- / aggregator-supplied
and not fully trusted, so lookout routes its default fetch transport through
[forage](https://github.com/kontourai/forage)'s SSRF-pinned guarded fetch
(`@kontourai/forage/egress`). A registered source pointing at a private,
link-local, loopback, or cloud-metadata host (e.g. `169.254.169.254`) is refused
before any connection — a drift check can never be turned into an SSRF vector.
A caller that injects its own `fetchSource` or `fetchOptions.fetch` (e.g. tests)
owns its transport and opts out of the default guard.

## Requirements

- Node.js `>= 22`.
- `@kontourai/forage` `>= 0.4.0`. Exact durable-reference replay requires the
  resolver first released in `0.4.0`; trustworthy `unchanged-304`
  classification also depends on Forage's validator-scoped revalidation.
  Lookout exact-pins Traverse separately for schema and extraction-proposal
  contracts.

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
    },
    {
      "id": "published-results",
      "kind": "structured-file",
      "format": "yaml",
      "url": "https://raw.githubusercontent.com/example/project/0123456789abcdef0123456789abcdef01234567/results.yml",
      "cadenceHint": "weekly"
    }
  ]
}
```

Fields per source:

| Field | Meaning |
| --- | --- |
| `id` | Non-empty, unique within the document. Used for exact lookup and snapshot identity. |
| `kind` | `web-page`, `api-record`, or `structured-file`. |
| `url` | Absolute HTTP(S) URL. |
| `format` | Required only for `structured-file`: `yaml`, `json`, or `csv`. Lookout does not parse it. |
| `targetSchema` | Required for `web-page` and `api-record`: Traverse `TargetFieldSchema[]`. Stored inert at L1 (no extraction yet). |
| `cadenceHint` | Non-empty string; advisory only — Lookout does not schedule. |
| `renderPolicy` | Required for `web-page` and `api-record`: `never` \| `on-shell-warning` \| `always`. **Inert** at L1. |

Structured-file entries retain raw fetched bytes and use the same guarded fetch,
snapshot, comparison, and replay path as every other source. Parsing and domain
normalization stay downstream. Prefer immutable, commit-pinned artifact URLs so
an upstream branch move cannot silently redefine the cited source location.

Validation reports **every** deterministic issue at once (with index/id context)
and never reads the network. Lookup is exact-id; listing preserves file order —
no merging, discovery, or remote registries.

## Check results

A check classifies each source into exactly one of four kinds. Every result
carries `sourceId`, the registered `sourceUrl`, `checkedAt`, and Forage fetch
warnings.

| `kind` | When | Extra fields |
| --- | --- | --- |
| `unchanged-304` | A validator-backed conditional request returned `304`; zero body transfer; the prior snapshot is not re-persisted. | `snapshotRef` |
| `unchanged-hash` | A full body was fetched and persisted, but its sha256 `bodyHash` equals the prior, **and** it came from the same resource URL — established by Lookout's own comparison. | `priorSnapshotRef`, `currentSnapshotRef` |
| `changed` | The fresh body differs from the prior (`changeBasis: "hash"`), **or** it is the first successful observation (`changeBasis: "initial"`, `priorSnapshotRef: null`). | `priorSnapshotRef` (nullable), `currentSnapshotRef`, `changeBasis` |
| `error` | Any operational failure — contained so the runner never rejects. | `origin` (`forage` \| `lookout`), `error` |

`unchanged-hash` asserts same-resource continuity, so it requires **both** an
identical `bodyHash` **and** the same resource URL as the prior snapshot. If a
source has moved — the prior snapshot's URL differs from this fetch's — the
result is `changed` even when the bytes are byte-identical, and the fresh
snapshot is persisted as the new baseline. (The `unchanged-304` path is already
resource-scoped by Forage's validators, so only the hash path needs this
guard.)

`error` results preserve provenance: `origin: "forage"` carries Forage's
discriminated `FetchError` verbatim (its `kind`, and `status` when present);
`origin: "lookout"` carries a typed `kind` — `prior-read`, `persistence`,
`dependency-contract`, or `unexpected`.

Snapshot references (`snapshotRef` / `priorSnapshotRef` / `currentSnapshotRef`)
are portable logical refs from Forage's `buildSnapshotSourceRef` — never
filesystem paths. Snapshots are stored via Forage's filesystem store, rooted by
default at `<cwd>/.kontourai/lookout/snapshots` (override with the CLI
`--snapshot-root` flag or by injecting a store in library use). Lookout adds no
custom filenames or retention. `resolveLookoutSnapshot()` replays one exact
reference through an injected store or Lookout snapshot root, authenticates its
body and replay metadata, and never fetches. References emitted before Forage's
replay-envelope digest remain resolvable with `integrity: "body-and-identity"`;
new references report `integrity: "snapshot-envelope"`.

## Schema coverage

Drift isn't only "the bytes changed" — a source can reformat so that a field
your schema *declares* silently stops being produced. The byte/proposal diffs
above are temporal (they need a prior and say nothing on a first look), so they
can't catch this. `checkSchemaCoverage` is the static complement:

```ts
import { checkSchemaCoverage } from "@kontourai/lookout";

if (source.kind === "structured-file") throw new Error("structured sources are parsed downstream");
const { covered, gaps } = checkSchemaCoverage(source.targetSchema, proposals);
// covered: declared paths at least one proposal produced (schema order)
// gaps:    declared paths that produced none, each with its `required` flag
for (const gap of gaps) {
  // escalate a missing required field harder than a missing optional one
}
```

It reduces one declared `TargetFieldSchema[]` and one produced
`ExtractionProposal[]` set into `{ covered, gaps }` by exact
`proposal.fieldPath === field.path`. It is pure and total — no prior, no
network, no throw — and answers on the very first observation. It measures the
produced set you pass (it runs no post-verification filtering itself), reports
only against the *declared* surface (an undeclared proposal path is neither
covered nor a gap), and preserves schema order. Escalation — warning, review
item, or hard failure — is the consumer's call.

## CLI

```
lookout check <id> [--registry <path>] [--snapshot-root <path>]
lookout check --all [--registry <path>] [--snapshot-root <path>]
lookout emit-drift <id> --observation <path|-> [--registry <path>] [--observation-root <path>]
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

`emit-drift` is a separate composable command: its input is a JSON object with
`observation` (a `ProposalSetObservation`) and its matching `check` anchor.
Extraction is supplied by the caller. The first successful input commits a
baseline fact and returns `priorObservationId: null` with empty `events`; a
genuine later change returns non-empty `events` and `facts` plus a
`priorObservationId` pointing at the prior observation it was diffed against.
State defaults to `.kontourai/lookout/observations`, uses immutable
digest-addressed records and an atomic per-source pointer, and retains the
latest two valid observations. The emitted `events` are already
Hachure-evidence-shaped; a consumer or product lifts them into a Hachure
`TrustBundle` with `@kontourai/surface`'s `TrustBundleBuilder` when it wants
Surface projection — lookout itself authors nothing in the trust layer.
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
Forage's SSRF-guarded fetcher), `fetchOptions`, and
`clock` — so checks run with no live network or timers in tests. Injecting either
`fetchSource` or `fetchOptions.fetch` overrides the default guarded transport.

## Observe changed sources without re-extracting unchanged ones

`createObserveExtractDiff` is an optional library composition for callers that
want one typed observation per check. Supply acquisition, extraction, and
recording capabilities; Lookout does not choose a content-preparation method,
provider, or observation database.

```ts
import { createObserveExtractDiff } from "@kontourai/lookout";

const composition = createObserveExtractDiff({
  acquisition: { check: runner.check },
  extraction: {
    async extract({ source, snapshotRef }) {
      // Resolve `snapshotRef`, prepare content, and invoke a caller-selected
      // extraction implementation. Return its public Traverse result.
      return extractChangedSource(source, snapshotRef);
    },
  },
  recorder: {
    async record(observation) {
      // Caller-owned continuity and durable storage.
      return saveObservation(observation);
    },
  },
});

const result = await composition.observe(source);
```

`unchanged-304` and `unchanged-hash` are recorded as `unchanged` and never call
the extraction capability, so they make zero preparation and provider calls.
Changed observations retain source and snapshot references, Traverse's prepared
artifact identity, the proposal set, and the current/prior observation
identities returned by the recorder. `partial`, `provider-failure`, mixed
`partial-provider-failure`, and `extraction-failure` remain distinct typed
outcomes. Provider failures are reduced to provider-neutral `kind` and
`retryable` classifications; provider names, messages, native diagnostics,
free-form extraction warnings, raw responses, and thrown-error text are not
copied into the durable observation.
A first changed observation
has `priorObservationId: null`; it is a baseline observation, not a fabricated
list of additions or removals.

The composition validates that the check identifies the requested registered
source and that Traverse validates the prepared artifact whose snapshot anchor
matches the current check. This prevents mismatched capability results from
being recorded as one observation. Proposal excerpts, source URLs, and
acquisition check warnings can still contain sensitive source material; callers
must apply their own retention and access policy before durable storage.

The existing `createCheckRunner` and `createDriftEmitter` entrypoints remain
available. Use `createDriftEmitter` when the caller wants deterministic
proposal-diff events with its own identity callbacks.

## Non-goals

Acquisition and extraction implementations, Surface projection, notifications,
crawling, review/escalation or authority policy, rendered-fetch wiring
(`renderPolicy` is inert), and scheduling. Forage retains all fetch politeness,
robots, redirects, retries, timeouts, headers, user-agent, and rendered-fetch
behavior.

## Development

```sh
npm ci
npm run verify   # content-boundary + decisions + typecheck + test + pack sanity
```

Individual gates: `npm test`, `npm run typecheck`, `npm run check:pack`,
`npm run check:decisions`, `npm run check:content-boundary`.

## License

Apache-2.0.
