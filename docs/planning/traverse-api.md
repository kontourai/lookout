# @kontourai/traverse API reference (v0.8.0) — for lookout/campfit implementers

Consumed from npm registry: `"@kontourai/traverse": "^0.8.0"`. `type: module`, Node >= 22.
Exports: `.` (extraction core), `./fetch`, `./anthropic` (optional peer dep `@anthropic-ai/sdk >= 0.20.0`).

## Fetch subpath — `@kontourai/traverse/fetch`

```typescript
interface SourceConfig {
  id: string;                 // stable, caller-owned identity
  url: string;                // absolute http(s) URL
  contentType?: "html" | "text" | "pdf" | "transcript"; // hint wins over header
  minDelayMs?: number;        // per-host politeness, default 1_000
  timeoutMs?: number;         // default 15_000
  retries?: number;           // default 2, max 5 (retries 429/5xx/network/timeout only)
  headers?: Record<string, string>;
  userAgent?: string;         // set an honest bot identity
  respectRobots?: boolean;    // default true; robots infra failure = fail-open with warning
  revalidate?: boolean;       // opt-in conditional GET (needs opts.store)
}

interface Snapshot {
  sourceId: string;
  url: string;                // FINAL url after redirects
  fetchedAt: string;          // ISO-8601
  status: number;
  contentType: "html" | "text" | "pdf" | "transcript"; // RESOLVED
  body: string;               // UTF-8 decoded
  bodyHash: string;           // lowercase hex sha-256 of body
  redirects?: string[];
  fromCache?: boolean;        // true when served from store (replay or 304 re-serve)
  etag?: string;              // verbatim response ETag
  lastModified?: string;      // verbatim response Last-Modified
  notModified?: boolean;      // true ONLY on a 304 Not Modified response
}

type FetchErrorKind = "invalid-config" | "invalid-url" | "robots-denied" | "timeout"
  | "network" | "http-error" | "too-many-redirects" | "no-snapshot"
  | "dependency-missing" | "adapter-error";
interface FetchError { kind: FetchErrorKind; message: string; status?: number; }
interface FetchResult { snapshot?: Snapshot; error?: FetchError; warnings?: string[]; }

interface SnapshotStore {
  put(snapshot: Snapshot): Promise<void>;
  latest(sourceId: string): Promise<Snapshot | undefined>;
  get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined>;
  list(sourceId: string): Promise<Snapshot[]>;
}

interface FetchSourceOptions {   // ALL injectable seams for tests
  fetch?: FetchLike;             // defaults to globalThis.fetch
  now?: () => number;            // ms clock
  clock?: () => string;          // ISO timestamp source
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;         // jitter
  schedule?: (ms: number, cb: () => void) => () => void;
  politenessState?: Map<string, number>;
  robotsCache?: Map<string, RobotsRules>;
  store?: SnapshotStore;         // consulted ONLY when config.revalidate === true
}

async function fetchSource(config: SourceConfig, opts?: FetchSourceOptions): Promise<FetchResult>
function sha256Hex(body: string): string
function createFilesystemSnapshotStore(opts: { root: string }): SnapshotStore
function createInMemorySnapshotStore(): SnapshotStore
async function replaySource(store: SnapshotStore, sourceId: string): Promise<FetchResult> // latest snapshot, fromCache: true

type FetchMode = "live" | "replay" | "live-with-capture";
interface FetchAndExtractOptions {
  targetSchema: TargetFieldSchema[]; provider: ExtractionProvider;
  store?: SnapshotStore; mode?: FetchMode; fieldHints?: Record<string, string>;
  maxContentChars?: number; prep?: "text" | "markdown";
  chunkSize?: number; chunkOverlap?: number; maxChunks?: number;
  fetchOptions?: FetchSourceOptions;
}
interface FetchAndExtractResult { fetch: FetchResult; extraction?: ExtractionResult; sourceRef?: string; }
async function fetchAndExtract(config: SourceConfig, opts: FetchAndExtractOptions): Promise<FetchAndExtractResult>
function buildSnapshotSourceRef(snapshot: Snapshot): string
// -> "traverse-snapshot:<sourceId>?url=<final-url>&sha256=<bodyHash>&fetchedAt=<iso>"
function parseSnapshotSourceRef(ref: string): { sourceId; url; bodyHash; fetchedAt } | undefined
```

Semantics that matter:
- `fetchSource` NEVER throws; every operational failure is `result.error` (typed).
- Conditional GET: with `config.revalidate: true` AND `opts.store`, fetchSource looks up `store.latest(id)`; if that snapshot carries `etag`/`lastModified`, it sends `If-None-Match`/`If-Modified-Since`. A 304 re-serves the byte-identical prior snapshot with `fromCache: true` and `notModified: true` (zero body transfer). No validators or no prior snapshot → normal fetch; sha256 `bodyHash` compare remains the drift signal. fetchSource only READS the store — persisting fresh snapshots is the caller's job (`store.put`) or `fetchAndExtract` with mode `live-with-capture`.
- An unsolicited 304 with no prior snapshot is a typed `http-error`, not an exception.

## Extraction core — `@kontourai/traverse`

```typescript
interface TargetFieldSchema {
  path: string;                    // e.g. "name", "items[].detailUrl"
  type: "string" | "number" | "boolean" | "date" | "enum" | "array" | "object";
  enumValues?: string[]; description?: string; required?: boolean;
  inferenceType?: "explicit" | "inferred";
}
interface ExtractionProposal {
  fieldPath: string;               // normalized (indexed forms get pathIndices)
  candidateValue: unknown;
  confidence: number;              // clamped 0..1
  provenance: { excerpt: string; locator: string }; // excerpt VERBATIM in prepared text; locator "chars:<start>-<end>"
  extractor: string;               // e.g. "anthropic-extraction-provider:claude-sonnet-4-6"
  pathIndices?: number[];          // e.g. items[2].name -> fieldPath "items[].name", pathIndices [2]
  inferenceType?: "explicit" | "inferred";
}
interface ExtractionResult {
  proposals: ExtractionProposal[];
  raw: { response: string; model: string; tokensUsed?: number };
  extractedAt: string; error?: string; warnings?: string[];
  providerCalls: number; totalTokensUsed: number;
  embedded?: { jsonLd: unknown[]; nextData?: unknown; initialState?: unknown };
  pdfPageOffsets?: number[];
}
interface ExtractInput {
  content: string | Uint8Array; contentType: ContentType;
  sourceRef: string;               // maps to Survey RawSource.sourceRef
  targetSchema: TargetFieldSchema[]; fieldHints?: Record<string, string>;
  provider: ExtractionProvider; pdfTextExtractor?: PdfTextExtractor;
  maxContentChars?: number;        // default 32_000
  prep?: "text" | "markdown";      // default "markdown" for html
  chunkSize?: number; chunkOverlap?: number; maxChunks?: number; // 12_000 / 200 / 40
  maxProviderCalls?: number; maxTotalTokens?: number;            // cost guards
}
async function extract(input: ExtractInput): Promise<ExtractionResult> // never throws

// Shell detection / embedded state (root exports)
const SHELL_WARNING_CODE = "js-shell-suspected";
const SHELL_WARNING_CODE_EMBEDDED = "js-shell-suspected-embedded-state-available";
// warnings entries START with these codes; check with startsWith.
```

## Anthropic adapter — `@kontourai/traverse/anthropic`

```typescript
interface AnthropicAdapterOptions {
  client?: AnthropicMessagesClient; // injected mock for tests — no SDK/key needed
  apiKey?: string;                  // falls back to ANTHROPIC_API_KEY
  model?: string;                   // default "claude-sonnet-4-6"
  maxTokens?: number;               // default 2048
  baseUrl?: string;                 // Anthropic-compatible endpoints
}
function createAnthropicExtractionProvider(opts?: AnthropicAdapterOptions): ExtractionProvider
```
Composes with datum: `createAnthropicExtractionProvider({ ...resolve("extraction-default") })`.

## Test pattern (traverse's own; copy it)

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// fake fetch keyed by URL:
const fetch = fakeFetch({ "https://example.test/page": { status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" } });
const result = await fetchSource(config, {
  fetch, clock: () => "2026-07-02T00:00:00.000Z", sleep: async () => {},
  random: () => 0, politenessState: new Map(), robotsCache: new Map(),
});
```
Remember: with `respectRobots` defaulted true, the fake fetch must also answer `<origin>/robots.txt` (or set `respectRobots: false` in test configs).

Build/test commands (traverse repo pattern): `npm run build` (tsc), `npm test` (= build + `node --test dist/tests/*.test.js`), `npm run verify`.
