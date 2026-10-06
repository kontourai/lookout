import type { ExactSnapshotLookupResult, ExactSnapshotStore, Snapshot, SnapshotLookup } from "@kontourai/forage";
import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import { resolveContentType } from "@kontourai/traverse/fetch";
import type { Snapshot as TraverseSnapshot, SnapshotStore as TraverseSnapshotStore } from "@kontourai/traverse/fetch";

/**
 * A Traverse snapshot store, presented as the Forage snapshot store the check
 * runner, `resolveLookoutSnapshot`, and observe-extract-diff read and write.
 *
 * The two stores describe one capture with different records. A Forage
 * capture carries the response headers and keeps a binary body as `body`
 * bytes; a Traverse record requires a resolved `contentType` and keeps a
 * binary body on `bodyBytes` beside an empty `body`. Traverse's bundled stores
 * refuse a record that lacks `contentType`, so a Traverse store passed to the
 * runner directly refuses every capture. This adapter translates both ways:
 *
 * - `put()` adds `contentType`, resolved from the captured `Content-Type`
 *   header the way Traverse's own fetcher resolves it (`html` for a rendered
 *   page), and moves a binary body to `bodyBytes`. Headers, text `bytes` and
 *   `declaredCharset` are stored as they are; Traverse's stores keep fields
 *   they do not declare.
 * - Reads return only the fields of a Forage snapshot, with a binary body back
 *   on `body`, so a capture reads back as the snapshot that was written and its
 *   durable reference keeps resolving.
 *
 * A record Traverse's own fetcher wrote has no `headers`. It reads back
 * without them, so the runner sends no conditional request from it.
 *
 * Forage stores a body it cannot classify as text (an image other than PNG or
 * JPEG, `application/octet-stream`) as bytes, while Traverse resolves its
 * content type to `text`. Such a record is written as `contentType: "text"`
 * with `bodyBytes`: the bytes are kept, which is what replay needs.
 *
 * Traverse stores cannot prune, so `retention` reports that it was skipped.
 */
export function fromTraverseSnapshotStore(store: TraverseSnapshotStore): ExactSnapshotStore {
  async function list(sourceId: string): Promise<Snapshot[]> {
    return (await store.list(sourceId)).map(toForageSnapshot);
  }
  return {
    async put(snapshot) {
      await store.put(toTraverseSnapshot(snapshot));
    },
    async latest(sourceId) {
      const record = await store.latest(sourceId);
      return record === undefined ? undefined : toForageSnapshot(record);
    },
    async get(sourceId, bodyHash) {
      const record = await store.get(sourceId, bodyHash);
      return record === undefined ? undefined : toForageSnapshot(record);
    },
    list,
    async findExact(reference: SnapshotLookup): Promise<ExactSnapshotLookupResult> {
      const sameIdentity = (await list(reference.sourceId)).filter((snapshot) =>
        snapshot.url === reference.url &&
        snapshot.bodyHash === reference.bodyHash &&
        snapshot.fetchedAt === reference.fetchedAt);
      if (sameIdentity.length === 0) return { kind: "missing" };
      const matches = reference.snapshotDigest === undefined
        ? sameIdentity
        : sameIdentity.filter((snapshot) =>
          parseSnapshotSourceRef(buildSnapshotSourceRef(snapshot))?.snapshotDigest === reference.snapshotDigest);
      // Two records with one identity and no digest to choose between them is
      // not an exact answer.
      return matches.length === 1 ? { kind: "found", snapshot: matches[0]! } : { kind: "mismatch" };
    },
  };
}

function toTraverseSnapshot(snapshot: Snapshot): TraverseSnapshot {
  const contentType = snapshot.rendered === true ? "html" : resolveContentType(undefined, contentTypeHeader(snapshot.headers) ?? null);
  const record: TraverseSnapshot & { headers?: Record<string, string> } = {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt,
    contentType,
    body: typeof snapshot.body === "string" ? snapshot.body : "",
    ...(typeof snapshot.body === "string" ? {} : { bodyBytes: snapshot.body }),
    ...(snapshot.bytes === undefined ? {} : { bytes: snapshot.bytes, declaredCharset: snapshot.declaredCharset ?? null }),
    bodyHash: snapshot.bodyHash,
    ...(snapshot.headers === undefined ? {} : { headers: snapshot.headers }),
    ...(snapshot.redirects === undefined ? {} : { redirects: snapshot.redirects }),
    ...(snapshot.rendered === undefined ? {} : { rendered: snapshot.rendered }),
  };
  return record;
}

function toForageSnapshot(record: TraverseSnapshot): Snapshot {
  const headers = storedHeaders(record);
  return {
    sourceId: record.sourceId,
    url: record.url,
    status: record.status,
    fetchedAt: record.fetchedAt,
    body: record.bodyBytes ?? record.body,
    ...(record.bytes === undefined ? {} : { bytes: record.bytes, declaredCharset: record.declaredCharset ?? null }),
    bodyHash: record.bodyHash,
    ...(headers === undefined ? {} : { headers }),
    ...(record.redirects === undefined ? {} : { redirects: record.redirects }),
    ...(record.rendered === undefined ? {} : { rendered: record.rendered }),
  };
}

function contentTypeHeader(headers: Record<string, string> | undefined): string | undefined {
  if (headers === undefined) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value;
  }
  return undefined;
}

/** The headers a Forage capture carried, or a refusal when the stored value is not a header record. */
function storedHeaders(record: TraverseSnapshot): Record<string, string> | undefined {
  const headers: unknown = (record as { headers?: unknown }).headers;
  if (headers === undefined) return undefined;
  if (
    typeof headers !== "object" || headers === null || Array.isArray(headers) ||
    !Object.values(headers).every((value) => typeof value === "string")
  ) {
    // Dropping them would change the capture's durable reference without a trace.
    throw new TypeError("a stored snapshot's headers are not a record of strings");
  }
  return { ...(headers as Record<string, string>) };
}
