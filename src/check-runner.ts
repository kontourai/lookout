import {
  buildSnapshotSourceRef,
  fetchSource as traverseFetchSource,
} from "@kontourai/traverse/fetch";
import type {
  FetchResult,
  FetchSourceOptions,
  Snapshot,
  SnapshotStore,
  SourceConfig,
} from "@kontourai/traverse/fetch";
import type { CheckResult, CheckResultCommon, LookoutErrorKind } from "./check-result.js";
import type { ProviderResolver } from "./provider-resolution.js";
import type { LookoutSource } from "./registry.js";

export type FetchSource = (config: SourceConfig, options?: FetchSourceOptions) => Promise<FetchResult>;

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
  const fetchImpl = options.fetchSource ?? traverseFetchSource;
  const clock = options.clock ?? (() => new Date().toISOString());

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
        { ...options.fetchOptions, store: options.store },
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
    if (prior.bodyHash === snapshot.bodyHash) {
      return { ...base, kind: "unchanged-hash", priorSnapshotRef, currentSnapshotRef };
    }
    return { ...base, kind: "changed", priorSnapshotRef, currentSnapshotRef, changeBasis: "hash" };
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
  const hasSnapshot = result.snapshot !== undefined;
  const hasError = result.error !== undefined;
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
