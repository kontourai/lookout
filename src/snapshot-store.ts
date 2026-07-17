import path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import type { SnapshotStore } from "@kontourai/forage";

export function createLookoutSnapshotStore(
  root = path.join(process.cwd(), ".kontourai", "lookout", "snapshots"),
): SnapshotStore {
  return createFilesystemSnapshotStore({ root });
}
