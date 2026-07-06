# Campfit implementation reference — for C1, C2, L4

Repo: `~/dev/github/briananderson1222/campfit` (Next.js + Prisma/Postgres). Test runner: vitest (`npm test` = `vitest run`; single file: `npx vitest run <path>`); traverse-shaped suites run via tsx scripts: `npm run test:recrawl-adapter`, `npm run test:traverse-replay`.

## Recrawl path (C1, L4)

Entry: `lib/ingestion/traverse-recrawl-adapter.ts`

```typescript
export async function runTraverseRecrawlForCamp(opts: TraverseRecrawlOptions): Promise<TraverseRecrawlResult>

export interface TraverseRecrawlOptions {
  campId: string; websiteUrl: string; campName: string;
  current: Camp;                                        // full row for computeDiff
  fieldSources?: Record<string, { approvedAt?: string }>;
  siteHints?: string[]; neighborhoods?: string[];
  provider: ExtractionProvider; store: SnapshotStore;
  mode?: FetchMode;                                     // default "live-with-capture"
  fetchOptions?: FetchSourceOptions;                    // test seam
  maxProviderCalls?: number; maxTotalTokens?: number; maxContentChars?: number;
  log?: (msg: string) => void; now?: () => number;
}
export interface TraverseRecrawlResult {
  ok: boolean; error: string | null; proposedChanges: ProposedChanges;
  overallConfidence: number; model: string; rawExtraction: Record<string, unknown>;
  matchedItemName: string | null; itemCount: number;
  snapshot: { ref: string | null; bodyHash: string | null };
  tokensUsed: number | null; providerCalls: number; latencyMs: number; warnings: string[];
}
```

It builds `IngestionSourceConfig { key: campId, name: campName, url: websiteUrl }` and calls
`runTraverseFetchAndAssemble(src, deps)` (`lib/ingestion/traverse-pipeline.ts:714`), whose deps carry
`provider, store, sink (no-op for recrawl), mode, fetchOptions, extraFieldHints, cost guards, log, now`.
The actual fetch happens inside `runFetchAndExtractAttempt` (`traverse-pipeline.ts:419-454`), which passes
`fetchOptions` through to traverse. **C1 plug-in point:** the `SourceConfig` built there needs `revalidate: true`,
and the flow between fetch and extract (~line 388 / 419-454) needs a `snapshot.notModified === true` branch
that returns early WITHOUT calling extract.

## computeDiff (the L2 generalization source)

`lib/ingestion/diff-engine.ts`:

```typescript
export function computeDiff(
  current: Camp,
  extracted: Partial<CampInput>,
  confidence: Record<string, number>,
  excerpts: Record<string, string> = {},
  fieldSources: Record<string, { approvedAt?: string }> = {},
  sourceUrl = ''
): ProposedChanges

const MIN_CONFIDENCE = 0.3;        // fields below are skipped
const SUPPRESS_DAYS = 30;
const SUPPRESS_CONFIDENCE = 0.8;
// suppression: if fieldSources[field].approvedAt is < 30 days old AND conf < 0.8 -> skip field
const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
// arrays: stableJson-normalized set compare;
// mode: currentItems.length === 0 ? 'populate' : isAdditive ? 'add_items' : 'update'
```

## lastVerifiedAt / selection

- Selection: `crawl-pipeline.ts:258` — `ORDER BY "lastVerifiedAt" ASC NULLS FIRST`.
- `lastVerifiedAt` + `dataConfidence` are written ONLY by `refreshCampVerificationCache(campId)` in
  `lib/admin/verification-authority.ts:542` (derives a verification rollup, then
  `UPDATE "Camp" SET "dataConfidence"=$1, "lastVerifiedAt"=$2 WHERE id=$3`).
- Camp model also has `lastCrawledAt DateTime?` (crawl bookkeeping) and
  `fieldSources Json?` = `Record<string, { approvedAt?: string }>`.
- There is NO 304 short-circuit today; C1 adds it.

## Discovery path (C2)

`lib/ingestion/llm-discovery.ts`:

```typescript
export async function discoverCampsFromUrl(url: string, options: { model?: string; maxChars?: number } = {}): Promise<DiscoveryResult>
export interface DiscoveredCampStub { name: string; detailUrl: string | null; snippet: string | null; }
// prompt demands JSON: { "isListingPage": bool, "camps": [{ name, detailUrl, snippet }] }
// LLM call: callLLM(prompt, modelOverride?) from llm-provider.ts (auto-select gemini -> anthropic -> ollama)

export function filterNewDiscoveries(stubs, existingNames, threshold = 0.75): DiscoveredCampStub[]
// Dice coefficient on name bigrams; >= 0.75 similarity to an existing name -> filtered out
```

Consumption: `crawl-pipeline.ts:348-360` — when 2+ camps share a URL it calls `discoverCampsFromUrl(listingUrl)`,
filters via `filterNewDiscoveries`, and `upsertCamp`s each new stub as a `dataConfidence: 'PLACEHOLDER'` Camp.

## Provider/config resolution

`lib/ingestion/resolve-extraction-provider.ts`:

```typescript
export function resolveExtractionProvider(): ResolvedExtractionProvider {
  const ref = process.env.TRAVERSE_ROLE || "extraction-default";
  const resolved = resolve(ref);                       // @kontourai/datum
  const model = process.env.TRAVERSE_MODEL || resolved.model;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || resolved.baseUrl;
  const maxTokens = process.env.TRAVERSE_MAX_TOKENS ? Number(...) : 2048;
  return { provider: createAnthropicExtractionProvider({ apiKey: resolved.apiKey, model, maxTokens, ...(baseUrl ? { baseUrl } : {}) }), ... };
}
// Cost guard defaults: DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE = 40, DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE = 450_000
```

## Snapshot store + UA

`lib/ingestion/traverse-snapshot-store.ts`:

```typescript
export const SNAPSHOT_STORE_ROOT = path.join(process.cwd(), ".kontourai", "campfit", "snapshots");
export function createCampfitSnapshotStore(root = SNAPSHOT_STORE_ROOT): SnapshotStore
export const CAMPFIT_FETCH_USER_AGENT = "CampFitBot/1.0 (+https://campfit.app/bot; contact: hello@campfit.app)";
```

## Test seams (copy this pattern)

`scripts/test-recrawl-adapter.ts:87-98`:

```typescript
function makeFixtureFetch(html: string): FetchLike {
  return async (fetchUrl: string) => {
    const isRobots = fetchUrl.endsWith("/robots.txt");
    return {
      status: 200,
      headers: { get: (n: string) => n.toLowerCase() === "content-type"
        ? (isRobots ? "text/plain" : "text/html; charset=utf-8") : null },
      text: async () => (isRobots ? "User-agent: *\nDisallow:" : html),
    };
  };
}
// usage: fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} }
// stub provider (no API key): tests/fixtures/traverse/stub-provider.ts createStubProvider(specs, opts)
//   spec: { fieldPath: "items[].name", candidateValue: "...", needle: "<verbatim text present in fixture>" }
```

Parity precedent: `scripts/cutover-report.ts` already compares pipelines using `fetchAndExtract` + `replaySource` over stored snapshots — use it as the template for the L4 parity report.
