import path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/traverse/fetch";
import type { SnapshotStore } from "@kontourai/traverse/fetch";

export function createLookoutSnapshotStore(
  root = path.join(process.cwd(), ".kontourai", "lookout", "snapshots"),
): SnapshotStore {
  return createFilesystemSnapshotStore({ root });
}
