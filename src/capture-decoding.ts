import { decodeTextBody } from "@kontourai/forage/fetch";
import type { Snapshot } from "@kontourai/forage/fetch";

/**
 * The encoding a text capture's body was decoded with, or `null` for a binary
 * capture. Two captures with the same bytes but a different decoding give the
 * extractor different text, so they are different captures.
 *
 * Text captures that carry `bytes` were decoded with their declared charset;
 * the label is resolved the way Forage decodes it, so `utf8` and `utf-8` are
 * the same decoding. Text captures without `bytes` (the earlier Forage record
 * format, and rendered pages) were decoded or serialized as UTF-8.
 */
export function captureDecoding(snapshot: Snapshot): string | null {
  if (typeof snapshot.body !== "string") return null;
  if (snapshot.bytes === undefined) return "utf-8";
  return decodeTextBody(new Uint8Array(0), snapshot.declaredCharset ?? null).encoding;
}
