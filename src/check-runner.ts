import {
  buildSnapshotSourceRef,
  fetchSource as traverseFetchSource,
} from "@kontourai/traverse/fetch";
import type {
  FetchLike,
  FetchResult,
  FetchSourceOptions,
  Snapshot,
  SnapshotStore,
  SourceConfig,
} from "@kontourai/traverse/fetch";
import { createGuardedFetch } from "@kontourai/forage/egress";
import type { CheckResult, CheckResultCommon, LookoutErrorKind } from "./check-result.js";
import type { ProviderResolver } from "./provider-resolution.js";
import type { LookoutSource } from "./registry.js";

export type FetchSource = (config: SourceConfig, options?: FetchSourceOptions) => Promise<FetchResult>;

/**
 * The default egress transport for lookout's registered-source fetches: forage's
 * SSRF-pinned guarded fetch. Registered source URLs are operator- / aggregator-
 * supplied and not fully trusted, so a source pointing at a private, link-local,
 * loopback, or cloud-metadata host is refused before any connection — a drift
 * check can never be turned into an SSRF vector. Only wired when lookout uses the
 * default traverse fetcher and the caller injected no `fetch`; a caller that
 * supplies its own `fetchSource` or `fetchOptions.fetch` (e.g. tests) owns the
 * transport. Created lazily and cached so the guard is built once, not per check.
 */
let cachedGuardedFetch: FetchLike | undefined;
function defaultGuardedFetch(): FetchLike {
  cachedGuardedFetch ??= createGuardedFetch() as unknown as FetchLike;
  return cachedGuardedFetch;
}

export interface CreateCheckRunnerOptions {
  store: SnapshotStore;
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
  const usingDefaultFetcher = options.fetchSource === undefined;
  const fetchImpl = options.fetchSource ?? traverseFetchSource;
  const clock = options.clock ?? (() => new Date().toISOString());

  // Guard the default traverse fetcher's egress with forage. A caller-supplied
  // fetcher or `fetchOptions.fetch` owns its own transport and is left as-is.
  const fetchOptions: Omit<FetchSourceOptions, "store"> = { ...options.fetchOptions };
  if (usingDefaultFetcher && fetchOptions.fetch === undefined) {
    fetchOptions.fetch = defaultGuardedFetch();
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

    let fetched: FetchResult;
    try {
      fetched = await fetchImpl(
        { id: source.id, url: source.url, revalidate: true },
        { ...fetchOptions, store: options.store },
      );
    } catch (error) {
      return lookoutError(common(), "unexpected", error);
    }

    const base = { ...common(), warnings: Array.isArray(fetched?.warnings) ? [...fetched.warnings] : [] };
    if (!isFetchResult(fetched)) {
      return lookoutError(base, "dependency-contract", "Traverse returned neither exactly one snapshot nor exactly one error");
    }
    if (fetched.error) {
      return { ...base, kind: "error", origin: "traverse", error: fetched.error };
    }

    // Defense-in-depth: even if a future guard gap let a malformed snapshot
    // through, any stray throw in classification/ref-building becomes a typed
    // `unexpected` lookout error rather than a rejection (R2 never-throw).
    try {
      const snapshot = fetched.snapshot;
      if (snapshot.notModified === true) {
        return { ...base, kind: "unchanged-304", snapshotRef: buildSnapshotSourceRef(snapshot) };
      }

      try {
        await options.store.put(snapshot);
      } catch (error) {
        return lookoutError(base, "persistence", error);
      }

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
