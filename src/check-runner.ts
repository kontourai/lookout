import { isDeepStrictEqual } from "node:util";
import {
  buildSnapshotSourceRef,
  fetchSource as forageFetchSource,
  isSnapshotHistoryFullError,
  parseSnapshotSourceRef,
} from "@kontourai/forage/fetch";
import type {
  FetchResult,
  FetchSourceOptions,
  Snapshot,
  SnapshotLookup,
  SnapshotStore,
  SourceConfig,
} from "@kontourai/forage/fetch";
import type { EgressPolicy } from "@kontourai/forage";
import { captureDecoding } from "./capture-decoding.js";
import type { CheckResult, CheckResultCommon, LookoutErrorKind } from "./check-result.js";
import type { ProviderResolver } from "./provider-resolution.js";
import type { LookoutSource } from "./registry.js";

export type FetchSource = (config: SourceConfig, options?: FetchSourceOptions) => Promise<FetchResult>;

/**
 * The egress policy for lookout's registered-source fetches. Registered source
 * URLs are operator- / aggregator-supplied and not fully trusted, so a source
 * pointing at a private, link-local, loopback, or cloud-metadata host must be
 * refused before any connection — a drift check can never be turned into an
 * SSRF vector. `forage`'s `fetchSource` builds its own SSRF-pinned guarded
 * transport from this policy whenever the caller doesn't inject a custom
 * `fetch` (e.g. tests), so this is the single shared policy literal — never
 * scattered per call site, never `{ guarded: false }`.
 */
const GUARDED_EGRESS: EgressPolicy = { guarded: true };

/**
 * Bounds each source's snapshot history with the store's `prune` capability.
 * After every stored capture, all but the newest `keepLast` snapshots are
 * removed, except the latest, the captures the result names, and every
 * snapshot `cited` returns. `cited` is read just before the prune, outside the
 * store's lock: a citation recorded after that read is not protected by that
 * prune, so record a citation before handing its reference out.
 */
export interface SnapshotRetention {
  /** Newest snapshots kept per source (a non-negative integer; the latest is always kept). */
  readonly keepLast: number;
  /**
   * Snapshot references the caller still cites for this source: recorded
   * observations, review rounds, exported receipts. Never pruned. When this
   * throws or returns anything but canonical references, nothing is pruned.
   */
  readonly cited: (sourceId: string) => Promise<readonly string[]> | readonly string[];
}

export interface CreateCheckRunnerOptions {
  store: SnapshotStore;
  /** Prune history after each stored capture. Without it, history is kept in full. */
  retention?: SnapshotRetention;
  fetchSource?: FetchSource;
  fetchOptions?: Omit<FetchSourceOptions, "store">;
  clock?: () => string;
  /** Reserved for L2. Deliberately never called by L1. */
  providerResolver?: ProviderResolver;
}

export interface CheckRunner {
  check(source: LookoutSource): Promise<CheckResult>;
  checkAll(sources: readonly LookoutSource[]): Promise<CheckResult[]>;
}

export function createCheckRunner(options: CreateCheckRunnerOptions): CheckRunner {
  const fetchImpl = options.fetchSource ?? forageFetchSource;
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetchOptions: Omit<FetchSourceOptions, "store"> = { ...options.fetchOptions };
  const retention = options.retention;
  if (retention !== undefined && (!Number.isSafeInteger(retention.keepLast) || retention.keepLast < 0 || typeof retention.cited !== "function")) {
    throw new TypeError("retention requires a non-negative integer keepLast and a cited function");
  }

  /** Apply retention for one source. Returns a warning instead of throwing: the capture is already stored. */
  async function prune(sourceId: string, keepAlso: readonly Snapshot[]): Promise<string | undefined> {
    if (retention === undefined) return undefined;
    if (typeof options.store.prune !== "function") return "snapshot retention skipped: the store cannot prune";
    const keep: SnapshotLookup[] = keepAlso.map((snapshot) => lookupOf(buildSnapshotSourceRef(snapshot))!);
    try {
      const cited = await retention.cited(sourceId);
      if (!Array.isArray(cited)) return "snapshot retention skipped: cited references are not a list";
      for (const reference of cited) {
        const lookup = lookupOf(reference);
        if (lookup === undefined) return "snapshot retention skipped: a cited reference is not a snapshot reference";
        if (lookup.sourceId === sourceId) keep.push(lookup);
      }
    } catch (error) {
      return `snapshot retention skipped: cited references could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await options.store.prune(sourceId, { keepLast: retention.keepLast, keep });
      return undefined;
    } catch (error) {
      return `snapshot retention failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function check(source: LookoutSource): Promise<CheckResult> {
    const common = (): CheckResultCommon => ({
      sourceId: source.id,
      sourceUrl: source.url,
      checkedAt: clock(),
      warnings: [],
    });

    let prior: Snapshot | undefined;
    try {
      prior = await options.store.latest(source.id);
    } catch (error) {
      return lookoutError(common(), "prior-read", error);
    }
    if (prior !== undefined && isTraverseRecord(prior)) {
      // Typically a Traverse store passed as the store. It refuses every
      // capture this runner writes, so its prior must not stand in for one.
      return lookoutError(
        common(),
        "prior-read",
        "the prior snapshot carries contentType or bodyBytes, the fields of a Traverse snapshot record; wrap a Traverse snapshot store with fromTraverseSnapshotStore()",
      );
    }

    let fetched: FetchResult;
    try {
      fetched = await fetchImpl(
        { id: source.id, url: source.url, egress: GUARDED_EGRESS },
        { ...fetchOptions, store: options.store },
      );
    } catch (error) {
      return lookoutError(common(), "unexpected", error);
    }

    const base = { ...common(), warnings: Array.isArray(fetched?.warnings) ? [...fetched.warnings] : [] };
    if (!isFetchResult(fetched)) {
      return lookoutError(base, "dependency-contract", "Forage returned neither exactly one snapshot nor exactly one error");
    }
    if (fetched.error) {
      return { ...base, kind: "error", origin: "forage", error: fetched.error };
    }

    // Defense-in-depth: even if a future guard gap let a malformed snapshot
    // through, any stray throw in classification/ref-building becomes a typed
    // `unexpected` lookout error rather than a rejection (R2 never-throw).
    try {
      const snapshot = fetched.snapshot;
      if (snapshot.notModified === true) {
        const snapshotBodyEncoding = bodyEncoding(snapshot);
        const priorBodyEncoding = prior === undefined ? undefined : bodyEncoding(prior);
        if (
          prior === undefined ||
          snapshotBodyEncoding === undefined ||
          snapshotBodyEncoding !== priorBodyEncoding ||
          snapshot.sourceId !== prior.sourceId ||
          snapshot.url !== prior.url ||
          snapshot.status !== prior.status ||
          snapshot.fetchedAt !== prior.fetchedAt ||
          snapshot.bodyHash !== prior.bodyHash ||
          !isDeepStrictEqual(snapshot.headers, prior.headers) ||
          !isDeepStrictEqual(snapshot.redirects, prior.redirects) ||
          snapshot.rendered !== prior.rendered
        ) {
          return lookoutError(base, "dependency-contract", "Forage returned a 304 snapshot without the matching prior capture");
        }
        return { ...base, kind: "unchanged-304", snapshotRef: buildSnapshotSourceRef(prior) };
      }

      // A byte-identical repeat of the stored capture is not appended: its only
      // new information is the check time, which the result carries. Both
      // refs then name the stored capture, which stays replayable.
      if (prior !== undefined && isRepeatCapture(prior, snapshot)) {
        const priorSnapshotRef = buildSnapshotSourceRef(prior);
        return { ...base, kind: "unchanged-hash", priorSnapshotRef, currentSnapshotRef: priorSnapshotRef };
      }

      // The capture just stored is kept even when it is not the newest (clock
      // skew, or another check storing a later capture first): its result names it.
      const keepAlso = prior === undefined ? [snapshot] : [snapshot, prior];
      try {
        await options.store.put(snapshot);
      } catch (error) {
        if (!isSnapshotHistoryFullError(error)) return lookoutError(base, "persistence", error);
        // A full history refuses every later capture. Retention frees space
        // (for example when it is enabled on a store that already reached the
        // ceiling), so prune once and retry; otherwise say what to do.
        const warning = await prune(source.id, keepAlso);
        if (retention === undefined || warning !== undefined) {
          if (warning !== undefined) base.warnings.push(warning);
          return historyFull(base, error.maxHistoryFiles);
        }
        try {
          await options.store.put(snapshot);
        } catch (retryError) {
          return isSnapshotHistoryFullError(retryError)
            ? historyFull(base, retryError.maxHistoryFiles)
            : lookoutError(base, "persistence", retryError);
        }
      }
      const retentionWarning = await prune(source.id, keepAlso);
      if (retentionWarning !== undefined) base.warnings.push(retentionWarning);

      const currentSnapshotRef = buildSnapshotSourceRef(snapshot);
      if (!prior) {
        return {
          ...base,
          kind: "changed",
          priorSnapshotRef: null,
          currentSnapshotRef,
          changeBasis: "initial",
        };
      }

      const priorSnapshotRef = buildSnapshotSourceRef(prior);
      // Same-resource continuity requires BOTH the resource URL and the body to
      // match. A moved resource (prior's final URL differs from this fetch's)
      // re-baselines as `changed` even when the bytes are identical — "unchanged"
      // must not claim continuity across a URL change.
      if (prior.url === snapshot.url && prior.bodyHash === snapshot.bodyHash) {
        return { ...base, kind: "unchanged-hash", priorSnapshotRef, currentSnapshotRef };
      }
      return { ...base, kind: "changed", priorSnapshotRef, currentSnapshotRef, changeBasis: "hash" };
    } catch (error) {
      return lookoutError(base, "unexpected", error);
    }
  }

  async function checkAll(sources: readonly LookoutSource[]): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const source of sources) results.push(await check(source));
    return results;
  }

  return { check, checkAll };
}

// Response headers other than the validators a later conditional request
// reuses (e.g. Date) are not compared: they differ on nearly every response.
const REVALIDATION_HEADERS = ["etag", "last-modified"] as const;

/** Same resource, same body, and nothing a later check reads differs. */
function isRepeatCapture(prior: Snapshot, current: Snapshot): boolean {
  const priorEncoding = bodyEncoding(prior);
  return priorEncoding !== undefined &&
    priorEncoding === bodyEncoding(current) &&
    prior.sourceId === current.sourceId &&
    prior.url === current.url &&
    prior.status === current.status &&
    prior.bodyHash === current.bodyHash &&
    // Same bytes under another charset decode to other text: a new capture.
    captureDecoding(prior) === captureDecoding(current) &&
    prior.rendered === current.rendered &&
    isDeepStrictEqual(prior.redirects, current.redirects) &&
    REVALIDATION_HEADERS.every((name) => prior.headers?.[name] === current.headers?.[name]);
}

/** Fields of a Traverse snapshot record; Forage's bundled stores never return them. */
function isTraverseRecord(snapshot: Snapshot): boolean {
  return Object.hasOwn(snapshot, "contentType") || Object.hasOwn(snapshot, "bodyBytes");
}

function lookupOf(reference: unknown): SnapshotLookup | undefined {
  if (typeof reference !== "string") return undefined;
  const parsed = parseSnapshotSourceRef(reference);
  if (parsed === undefined) return undefined;
  const { sourceId, url, bodyHash, fetchedAt, snapshotDigest } = parsed;
  return { sourceId, url, bodyHash, fetchedAt, ...(snapshotDigest === undefined ? {} : { snapshotDigest }) };
}

function historyFull(common: CheckResultCommon, maxHistoryFiles: number): CheckResult {
  return lookoutError(
    common,
    "history-full",
    `snapshot history for this source holds its maximum of ${maxHistoryFiles} records; configure snapshot retention or prune the store`,
  );
}

function bodyEncoding(snapshot: Snapshot): "utf8" | "bytes" | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, "body");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  if (typeof descriptor.value === "string") return "utf8";
  return descriptor.value instanceof Uint8Array ? "bytes" : undefined;
}

function isFetchResult(value: unknown): value is { snapshot: Snapshot; error?: never; warnings?: string[] } | { error: NonNullable<FetchResult["error"]>; snapshot?: never; warnings?: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as FetchResult;
  const hasSnapshot = result.snapshot != null;
  const hasError = result.error != null;
  return hasSnapshot !== hasError;
}

function lookoutError(
  common: CheckResultCommon,
  kind: LookoutErrorKind,
  cause: unknown,
): CheckResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { ...common, kind: "error", origin: "lookout", error: { kind, message } };
}
