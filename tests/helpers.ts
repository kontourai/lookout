import { createHash } from "node:crypto";
import type { Snapshot, SnapshotStore } from "@kontourai/traverse/fetch";
import type { LookoutSource } from "../src/registry.js";

export function source(id = "source-a", overrides: Partial<LookoutSource> = {}): LookoutSource {
  return {
    id,
    kind: "web-page",
    url: `https://example.test/${id}`,
    targetSchema: [{ path: "title", type: "string", required: true }],
    cadenceHint: "daily",
    renderPolicy: "never",
    ...overrides,
  };
}

export function snapshot(
  sourceId: string,
  body: string,
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    sourceId,
    url: `https://example.test/${sourceId}`,
    fetchedAt: "2026-07-10T12:00:00.000Z",
    status: 200,
    contentType: "text",
    body,
    bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
    ...overrides,
  };
}

export function memoryStore(seed: Snapshot[] = []): SnapshotStore & { puts: Snapshot[] } {
  const values = [...seed];
  const puts: Snapshot[] = [];
  return {
    puts,
    async put(value) {
      puts.push(value);
      values.push(value);
    },
    async latest(sourceId) {
      return values.filter((item) => item.sourceId === sourceId).at(-1);
    },
    async get(sourceId, bodyHash) {
      return values.find((item) => item.sourceId === sourceId && item.bodyHash.startsWith(bodyHash));
    },
    async list(sourceId) {
      return values.filter((item) => item.sourceId === sourceId).reverse();
    },
  };
}
