import { isDeepStrictEqual } from "node:util";
import {
  buildSnapshotSourceRef,
  fetchSource as forageFetchSource,
} from "@kontourai/forage/fetch";
import type {
  FetchResult,
  FetchSourceOptions,
  Snapshot,
  SnapshotStore,
  SourceConfig,
} from "@kontourai/forage/fetch";
import type { EgressPolicy } from "@kontourai/forage";
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
  const fetchImpl = options.fetchSource ?? forageFetchSource;
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetchOptions: Omit<FetchSourceOptions, "store"> = { ...options.fetchOptions };

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
