# lookout — idea-to-backlog

- artifact: lookout--idea-to-backlog
- created: 2026-07-05
- builder_kit_shape: invoked via the product-level Builder Kit shape surface (`builder-shape` skill); shaping delegated to `idea-to-backlog` per contract.
- flow_definition: kits/builder/flows/shape.flow.json
- issue_sync_status: completed (2026-07-06, explicit user request)
- session_context: shaped from a live design conversation covering traverse (ADR 0001/0002/0005, docs/decisions/http-validators.md), survey (SurveyInput contract v1), surface, datum, campfit ingestion (traverse-pipeline, traverse-recrawl-adapter, llm-discovery, render-fetch), and boo scheduling.

## phase

`backlog` — issues synced 2026-07-06 on explicit user request.

## source_ideas

Raw input (user, 2026-07-05): "I'd like to have some primitive in my building blocks of products that I can set up for searching the web and setting up monitoring of sites — finding news, monitoring news (tickets go on sale, some anticipated thing is announced, camp updates found, new camps offered by provider). AI can help parse content into useful shapes, ideally integrating with survey → surface."

Deduped against existing threads:

- kontourai/ops#75 "URL recheck" story — traverse's HTTP-validators decision (docs/decisions/http-validators.md, 2026-07-05) explicitly implements the check MECHANICS for this and assigns recheck ORCHESTRATION to "the kit". Lookout is that orchestration layer; link, don't duplicate.
- traverse docs/slice-3-candidates.md — multi-page crawl frontier, headless rendering, and scheduling were deliberately deferred out of traverse slice 2. Lookout must not silently re-import them into traverse.
- campfit traverse-recrawl-adapter `computeDiff` (confidence floor, 30-day/0.8 suppression, additive-vs-replace array diff) — the domain-specific embryo of lookout's event/diff engine.
- campfit `llm-discovery.ts` (`discoverCampsFromUrl`) — hand-rolled `callLLM()` listing-page discovery; candidate for migration to traverse extraction independent of lookout.

## idea_inventory

| id | idea | class | outcome | reason |
|----|------|-------|---------|--------|
| I1 | Lookout: source registry + drift detection (check runner over traverse fetch/snapshot/conditional-GET) | feature | shape | Core of the new primitive; first consumer identified (campfit). |
| I2 | Lookout: event semantics — generalized diff over extraction-proposal sets → typed events | feature | shape | The reusable heart; generalizes campfit computeDiff. Depends on I1. |
| I3 | Lookout: SurveyInput emission → Surface trust bundles (provenance-bearing events/claims) | feature | shape | The differentiator: monitoring alerts as evidence-chain claims. Depends on I2. |
| I4 | Campfit cutover: recrawl + new-camps flows consume lookout | feature | shape | Proves the primitive against real data; retires bespoke diff path. Depends on I3. |
| I5 | Campfit: wire `revalidate: true` (conditional GET) into recrawl now | chore | commit | Tiny, immediate value, zero lookout dependency; traverse shipped it 2026-07-05. |
| I6 | Campfit: migrate `llm-discovery.ts` listing discovery onto traverse `extract()` | feature | shape | Standalone value (provenance + snapshots for discovery); also road-tests "links as extraction targets" that lookout's new-entity events will rely on. |
| I7 | API-endpoint acquisition rung: watch a SPA's underlying JSON API instead of its page | research | research | Traverse can likely fetch+extract JSON as `text` today; needs a spike to confirm before it becomes a lookout source kind. Survey already has RawSource kind `api-record`. |
| I8 | News search front door: search API → candidate URLs → same pipeline | feature | park | Different acquisition mode; premature before L1–L3 exist. Revisit trigger: L3 complete. |
| I9 | Traverse `/crawl` subpath (frontier mechanics) | feature | park | Boundary decision: only if lookout proves frontier need AND a second consumer wants it. |
| I10 | Notification/alert delivery channels (email, push, etc.) | feature | park | For campfit-first, the review sink IS the delivery. Revisit trigger: first non-campfit consumer or explicit user ask. Boo can trigger; ops owns channels. |
| I11 | Campfit: map traverse embedded-state sidecar (JSON-LD/`__NEXT_DATA__`) onto camp fields | feature | park | Known gap (sidecar is telemetry-only today); separate product decision, related-only to lookout. |

## slice_candidates

- **L1 (I1)** — `kontourai/lookout` bootstrap: `LookoutSource` registry (id, url or api-endpoint, target field schema, cadence *hint*, render policy) + a check runner composing traverse `fetchSource` with `revalidate: true` and a `SnapshotStore`, emitting typed `CheckResult`s: `unchanged-304`, `unchanged-hash`, `changed`, `error`. CLI entry (`lookout check <source-id|--all>`); provider/model resolution via datum `resolve()`. Success signal: run against ≥2 real campfit sources; observe a 304 path, a hash-unchanged path, and a changed path; snapshots persisted and replayable. Non-goals: no diffing, no events, no scheduling (boo invokes the CLI), no rendering (render policy is data, honored by the caller's injected fetch).
- **L2 (I2)** — event semantics: diff engine over two extraction-proposal sets keyed by `fieldPath` (+ `pathIndices` for arrays), producing typed events `new-entity-appeared`, `field-changed`, `anticipated-value-arrived`; policy inputs generalized from campfit `computeDiff` (confidence floor, suppression window, additive-vs-replace). Success signal: campfit's existing computeDiff test cases pass as lookout fixtures; one synthetic anticipated-value case fires exactly once. Non-goals: no review policy, no persistence beyond an event log, no notification.
- **L3 (I3)** — survey emission: package a check + its events as `SurveyInput` (RawSource kind `web-page`/`api-record` → Extraction → CandidateSet → ReviewOutcome-ready), projecting to a Surface trust bundle. Success signal: one real camp-update event round-trips to a trust bundle carrying verbatim excerpt + snapshot sha256 + observedAt. Non-goals: lookout does not resolve truth or own review policy.
- **L4 (I4)** — campfit cutover: recrawl adapter consumes lookout (L1–L3) in place of the bespoke fetch/diff path; oldest-first selection stays in campfit; rendering stays behind campfit's `FetchLike` seam. Success signal: recrawl parity run (replay-mode) shows equivalent-or-better proposedChanges vs the legacy path; legacy computeDiff path deleted or flagged off.
- **C1 (I5)** — campfit conditional-GET wiring: `revalidate: true` + snapshot store on recrawl fetches; record "checked, still current" cheaply. Success signal: recrawl of an unchanged page transfers no body (304) and updates `lastVerifiedAt`.
- **C2 (I6)** — llm-discovery migration: `discoverCampsFromUrl` reimplemented as traverse `extract()` with target schema `{name, detailUrl}` (+ snippet), keeping campfit's dedupe (Dice 0.75) and PLACEHOLDER insertion. Success signal: same-or-better stub yield on the existing listing fixtures, now with excerpt provenance and snapshots.
- **S1 (I7)** — spike, timeboxed 1 day: can traverse fetch+extract a JSON API response today (contentType `text`) with usable locators, or does lookout need anything new from traverse? Artifact: short findings note in this directory; no production code. Cleanup: none (read-only spike).

## bundle_justification

- L1 bundles "source registry" + "drift detection" because a registry without a check loop delivers no independent value; the check runner is the thinnest unit that reaches an evidence gate.
- L2, L3, L4 are deliberately split: each is independently testable (fixture diffs; bundle round-trip; parity run) and each unlocks the next. Dependency order explicit below.
- C1 and C2 are NOT bundled with lookout: both deliver value now with zero lookout dependency. Bundling them would couple immediate wins to a new-repo bootstrap.
- I8/I9/I10/I11 are explicitly parked rather than bundled — same user, different outcomes and acceptance signals.

## dependency_map

- L1 → blocks L2 → blocks L3 → blocks L4
- C1: independent (related-only to L1; L1 reuses the same traverse revalidate mechanics)
- C2: independent (related-only to L2/L4; its listing extraction becomes the feed for new-entity events at L4)
- S1: informs L1's source-kind design; not blocking (L1 can ship URL sources only)
- I8 (news search): blocked-by L3
- I9 (/crawl): blocked-by evidence from L4 + a second consumer
- I10 (notifications): blocked-by first non-campfit consumer or explicit ask
- I11 (sidecar mapping): related-only; campfit product decision

## decisions

| decision | rationale | decided by | date |
|----------|-----------|------------|------|
| First consumer is campfit camp updates | Real sources/data exist; computeDiff embryo lives there; lowest-risk proof | Brian | 2026-07-05 |
| New repo `kontourai/lookout`, not incubation in campfit, not a traverse subpath | "Building block of products" intent; traverse stays mechanics-only per its ADRs | Brian | 2026-07-05 |
| Name: **lookout** | On-brand with the surveying/cartography family (traverse, survey, surface, datum, station, hachure); a lookout point literally means watching | Brian | 2026-07-05 |
| Traverse stays mechanics-only: no scheduling, rendering, field vocabulary, or crawl frontier; `/crawl` + diff helpers only if lookout proves the need | Consistent with traverse ADR 0001/0002 and the mechanics-vs-orchestration rule in docs/decisions/http-validators.md | Brian (prior session decisions) | 2026-07-05 |
| Scheduling stays in boo; lookout stores a cadence *hint* only and exposes a CLI boo can invoke | Traverse deferred scheduling deliberately; boo already exists | Brian | 2026-07-05 |
| Rendering stays app-side behind an injected `FetchLike`; lookout carries render *policy* as data, routed by traverse's js-shell warnings (sidecar first, JSON API second, render last) | Chromium is the fallback rung, not the method; keeps lookout thin | carried from design discussion | 2026-07-05 |
| Lookout MAY take runtime deps on @kontourai/survey (builder) and @kontourai/datum | Lookout is a composition layer — taking deps is its whole point; the types-only discipline applies to mechanics packages like traverse, not orchestrators | shaped this session | 2026-07-05 |
| Stop at backlog gate; no GitHub issue sync | Explicit user instruction | Brian | 2026-07-05 |

## opportunity_briefs

- **Lookout (L1–L4)** — problem: no reusable way to watch a web source and learn that something meaningful happened, with evidence. Stakeholder: Brian (portfolio builder), campfit admins (first users). Outcome: registered sources checked cheaply on a cadence, meaningful changes surfaced as typed events that carry verbatim-excerpt + snapshot-hash provenance into survey → surface. Confidence: high on L1/C1 (mechanics shipped), medium on L2 (generalization risk), medium-high on L3/L4. Size: L1 ~2–3 days incl. repo bootstrap; L2 ~2–3 days; L3 ~1–2 days; L4 ~2–3 days.
- **C1/C2 (campfit quick wins)** — problem: recrawl always re-downloads; discovery has no provenance. Outcome: cheap freshness checks; discovery joins the evidence chain. Confidence: high. Size: C1 <1 day; C2 ~1–2 days.
- Displaces: near-term deepening of campfit's bespoke ingestion (frozen except C1/C2 until L4 lands).

## shaped_work

### L1 — lookout: source registry + drift check runner

Story: As the portfolio operator, I want to register web/API sources and run cheap checks against them, so that I know which sources changed without re-downloading or re-extracting anything that didn't.

Scope: new repo `kontourai/lookout`; `LookoutSource` type + file-based registry; check runner over traverse `/fetch` with `revalidate: true` + filesystem `SnapshotStore`; typed `CheckResult`; CLI `lookout check`; datum-resolved provider config plumbed but unused until L2.
Non-goals: diffing, events, scheduling, rendering, notifications, multi-page crawl.

Requirements:
- R1: `LookoutSource` = { id, kind: "web-page" | "api-record", url, targetSchema, cadenceHint, renderPolicy: "never" | "on-shell-warning" | "always" } persisted in a file-based registry.
- R2: check runner composes traverse `fetchSource` with `revalidate: true` and a `SnapshotStore`; never throws; typed `CheckResult` ∈ {unchanged-304, unchanged-hash, changed, error} with snapshot refs.
- R3: CLI `lookout check <id|--all>` prints/logs machine-readable results (boo-invokable).
- R4: politeness/robots/retry behavior is traverse's; lookout adds no fetch policy of its own.

Acceptance criteria:
- AC1 (R1,R3): registering 2 real campfit sources and running `lookout check --all` produces one result per source with stored snapshots.
- AC2 (R2): against a server sending ETag, an unchanged re-check yields `unchanged-304` with zero body transfer; without validators, an unchanged body yields `unchanged-hash` via sha256 compare.
- AC3 (R2): a changed body yields `changed` with both prior and current snapshot refs.
- AC4 (R2): network failure/timeouts yield `error` with traverse's discriminated FetchError; process exits 0 with the error in the result.

Verification expectation: unit tests with injected fetch seams (traverse pattern — no live network in CI); one recorded live run against real sources as evidence; AC ids preserved in the evidence table.

### L2 — lookout: event semantics (typed diff engine)

Story: As a product integrating lookout, I want changed sources turned into typed events, so that "tickets on sale" or "camp price changed" is a first-class signal, not a diff I re-derive.

Scope: diff over prior/current `ExtractionProposal[]` keyed by fieldPath+pathIndices; events `new-entity-appeared`, `field-changed`, `anticipated-value-arrived`; policy inputs {confidenceFloor, suppressionWindow, arrayMode}; extraction invoked through traverse with datum-resolved provider.
Non-goals: review policy, truth resolution, notification, storage beyond an append-only event log.

Requirements:
- R1: pure diff function (proposals × proposals × policy → events[]) with no I/O.
- R2: event carries source id, fieldPath, prior/current values+confidence, and provenance refs (excerpts + snapshot hashes) for both sides where they exist.
- R3: `anticipated-value-arrived` fires exactly once per (source, fieldPath) transition from absent/null to present, then is suppressed.
- R4: campfit computeDiff behaviors (floor, 30-day/0.8 suppression, additive-vs-replace) are expressible as policy — ported cases pass.

Acceptance criteria:
- AC1 (R1,R4): campfit's computeDiff test cases, ported as fixtures, produce equivalent outcomes.
- AC2 (R3): synthetic on-sale fixture (null → date) emits one `anticipated-value-arrived` and none on the following unchanged check.
- AC3 (R2): every emitted event's provenance refs resolve to stored snapshots.

Verification expectation: fixture-driven unit tests; AC table in closure evidence.

### L3 — lookout: SurveyInput emission → Surface

Story: As a trust-chain consumer, I want lookout events delivered as survey evidence, so that an alert is an inspectable claim, not a bare ping.

Scope: map a check+events to `SurveyInput` v1 (RawSource kind web-page/api-record; Extraction/CandidateSet from proposals; claims for event subjects) using survey's builder; project via `buildSurveyTrustBundle`.
Non-goals: review outcomes beyond "needs-review" defaults; any surface-side changes.

Requirements:
- R1: emitted batches validate as SurveyInput contract v1 (contractVersion set).
- R2: RawSource.sourceRef uses traverse's snapshot-anchored scheme so the exact bytes are recoverable.
- R3: an event-less check emits nothing (no empty-batch noise).

Acceptance criteria:
- AC1 (R1,R2): one real camp-update event round-trips: check → event → SurveyInput → trust bundle, with excerpt + sha256 + observedAt intact.
- AC2 (R3): unchanged checks produce no SurveyInput.

### L4 — campfit consumes lookout

Story: As campfit, I want recrawl and new-camp detection to ride lookout, so that camp updates and newly listed camps arrive as provenance-bearing events with one shared engine.

Scope: recrawl adapter delegates fetch/diff to lookout; camp sources registered as LookoutSources; listing pages (post-C2) feed `new-entity-appeared`; campfit keeps selection order, rendering seam, review sink, and field vocabulary.
Non-goals: changing campfit's review UX; retiring the render seam.

Acceptance criteria:
- AC1: replay-mode parity run vs legacy path shows equivalent-or-better proposedChanges on the existing snapshot corpus.
- AC2: a new camp on a watched listing page surfaces as `new-entity-appeared` → PLACEHOLDER camp with provenance.
- AC3: legacy bespoke diff path removed or feature-flagged off.

### C1 — campfit: conditional GET on recrawl (independent, do first)

R1: recrawl fetches pass `revalidate: true` + store. AC1: unchanged page → 304, no body, `lastVerifiedAt` updated. AC2: changed page behaves exactly as today.

### C2 — campfit: llm-discovery on traverse (independent)

R1: `discoverCampsFromUrl` uses traverse `extract()` with `{name, detailUrl, snippet}` schema; R2: dedupe + PLACEHOLDER insert unchanged; R3: discovery runs capture snapshots. AC1: existing listing fixtures yield same-or-better stubs; AC2: every stub carries a verbatim excerpt + snapshot ref.

## risk_release_notes

- Risk class: low-to-medium overall. L1/C1/C2 low (mechanics shipped, fixture-testable). L2 medium — premature generalization is the classic failure; mitigation: campfit fixtures are the spec, add no event type without a driving case. L4 medium — parity risk; mitigation: replay-mode corpus comparison before cutover, feature flag for rollback.
- Rollout: lookout versions independently (0.x, repo-consumed like datum pre-npm); campfit cutover behind a flag.
- Rollback: L4 flag off restores legacy path; C1/C2 are additive and individually revertible.
- Observability: check results and events are append-only logs; every event resolves to snapshots (replayable); token/cost ceilings via traverse's cost guards.

## backlog_links

Synced 2026-07-06 (user requested). Repo `kontourai/lookout` created for the sync (public, matching portfolio norm) with initial commit `df4dc29` as planned base.

| slice | issue | status |
|-------|-------|--------|
| L1 registry + drift checks | https://github.com/kontourai/lookout/issues/1 | open, ready for pull-work |
| L2 event semantics | https://github.com/kontourai/lookout/issues/2 | open, blocked by lookout#1 |
| L3 survey emission | https://github.com/kontourai/lookout/issues/3 | open, blocked by lookout#2 |
| S1 JSON-API spike | https://github.com/kontourai/lookout/issues/4 | open, ready (timeboxed 1 day) |
| C1 conditional GET in recrawl | https://github.com/briananderson1222/campfit/issues/77 | open, ready for pull-work |
| C2 llm-discovery → traverse | https://github.com/briananderson1222/campfit/issues/78 | open, ready for pull-work |
| L4 campfit cutover | https://github.com/briananderson1222/campfit/issues/79 | open, blocked by lookout#3 (advisory: land C2 first) |

Milestone strategy (recorded per contract): repo milestone `lookout v0.1 — campfit-proven monitoring primitive` on lookout#1–4; campfit issues carry no campfit milestone by decision (they contribute to the lookout-tracked outcome; C1/C2 also deliver standalone value). Each issue body preserves R*/AC* ids, prose Dependencies/Blockers, and the `flow-agents:work-item-metadata` marker with per-repo `planned_base_sha` (lookout `df4dc293e28f…`, campfit `a6225b64de01…`, planned_at 2026-07-06T01:43:42Z) and structured `blockers[]`.

**Enrichment pass (2026-07-06, user requested "as much detail as possible so a lesser capable model can pick it up"):** every issue body was extended with a full Implementation Guide — exact API signatures verified against source (traverse 0.8.0, survey 1.5.0, datum 0.3.0, campfit main), step-by-step file plans, seam-injection test matrices mapped to AC ids, evidence-run instructions, and pitfalls. Verified API reference docs live at `.kontourai/flow-agents/lookout/reference/` (`traverse-api.md`, `survey-api.md`, `campfit-implementation.md`, `portfolio-conventions.md`) and are cited in each issue's `planning_scope_refs`. Notable facts pinned during enrichment: traverse + survey are on npm (`^0.8.0` / `^1.5.0`); datum is unpublished — consume via `github:kontourai/datum`; portfolio package convention is node:test + strict tsc (no vitest/eslint in packages; vitest is campfit-only); traverse locators are prepared-text offsets → survey `locatorScheme: "text-span"`; C1 must NOT call `refreshCampVerificationCache` on 304 (dataConfidence belongs to the verification authority); L4 must keep snapshot sourceIds stable across cutover or etag lineage breaks.

## capture_audit (2026-07-06)

Loose-end audit after sync. Findings and fixes:
1. **traverse revalidate unreleased** — the `revalidate`/`etag`/`notModified` mechanics live on OPEN PR kontourai/traverse#32 (closes traverse#31); no released version (≤0.9.0) carries them. lookout#1 and campfit#77 now carry traverse#32 as a structured blocker; L1 can build everything except the 304 path against ^0.9.0 meanwhile. Landing traverse#32 is an owner review call.
2. **Artifacts made durable** — this artifact + the 4 reference docs are committed at kontourai/lookout `docs/planning/` (commit b001198); all 7 issues now point there (body edits on lookout#1/campfit#77, comments on the rest). The `~/dev/github/kontourai/.kontourai/flow-agents/lookout/` copy remains the working original; keep the repo copy in sync on material edits.
3. **ops#75 cross-linked** — comment added linking lookout#1 + campfit#77 as the orchestration half and recording the open close-or-wrap question.
4. Parked ideas below are durable via (2); none needs an issue yet.

## parked_or_rejected

- I8 news search front door — parked; revisit when L3 lands.
- I9 traverse `/crawl` subpath — parked; revisit when L4 evidence shows a frontier need AND a second consumer exists.
- I10 notification channels — parked; revisit on first non-campfit consumer or explicit ask.
- I11 embedded-state → camp-field mapping — parked as a campfit product decision; related-only.
- Rejected: incubating lookout inside campfit (chose new repo); traverse subpath home (violates mechanics-only boundary).

## open_questions

- Final event vocabulary: are three event types right, or is `entity-disappeared` needed for L4 (camp delisted)? Owner: Brian. Evidence: L4 parity run.
- Lookout state home: file-based registry/event-log location and retention (traverse snapshot store has no retention policy yet — slice-3 candidate there). Owner: Brian. Evidence: L1 usage.
- S1 outcome: does JSON-API watching need anything from traverse (locator scheme for JSON?), or is `text` contentType sufficient? Owner: spike. Evidence: S1 findings note.
- ops#75 linkage: should lookout formally close the "URL recheck" story or does ops keep a thin wrapper? Owner: Brian.

## next_gate

Backlog Gate — **pass** (2026-07-06). All seven issues synced with stable R*/AC* ids, dependency markers, and evidence expectations; each is ready for `pull-work` or explicitly marked blocked. Expected next step: `pull-work` (ready now: lookout#1, lookout#4, campfit#77, campfit#78). Mode: manual — downstream delivery starts only on user request.
