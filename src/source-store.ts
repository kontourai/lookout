import { parseRegistry, type LookoutRegistry, type LookoutSource } from "./registry.js";

/**
 * The seam between where sources live and everything Lookout does with them.
 *
 * Check classification, drift emission, and observation lineage all key off a
 * source's identity (`LookoutSource.id`), not off the file the source was
 * declared in. A `SourceStore` is the minimal contract those parts actually
 * consume: enumerate sources and resolve one by exact id. The bundled file
 * registry (`loadRegistry` / `LookoutRegistry`) is one implementation; an
 * application whose canonical source of truth is its own database can
 * implement this directly, or materialize rows through
 * {@link inMemorySourceStore}, and still inherit lineage, continuity, and
 * CHECK classification.
 *
 * Methods may return values synchronously or as promises so that an
 * in-memory store stays allocation-free while a database-backed store can
 * query lazily. Callers must `await` both methods.
 */
export interface SourceStore {
  /** Every source, in the store's canonical order. */
  list(): readonly LookoutSource[] | Promise<readonly LookoutSource[]>;
  /** Exact-id lookup; `undefined` when the id is not present. */
  get(id: string): LookoutSource | undefined | Promise<LookoutSource | undefined>;
}

/**
 * Build a validated in-memory {@link SourceStore} from sources an application
 * constructed itself (for example, from its own database rows).
 *
 * Runs exactly the validation `loadRegistry` applies to a registry file —
 * duplicate ids, URL shape, per-kind field rules — and throws the same
 * `RegistryValidationError` reporting every issue at once. The returned store
 * is a `LookoutRegistry`, so file-backed and in-memory sources are
 * indistinguishable downstream.
 */
export function inMemorySourceStore(sources: readonly LookoutSource[]): LookoutRegistry {
  return parseRegistry({ version: 1, sources });
}
