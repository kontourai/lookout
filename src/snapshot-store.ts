import path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import type { SnapshotStore } from "@kontourai/forage";
import {
  resolveSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";

export function createLookoutSnapshotStore(
  root = path.join(process.cwd(), ".kontourai", "lookout", "snapshots"),
): SnapshotStore {
  return createFilesystemSnapshotStore({ root });
}

export type ResolveLookoutSnapshotOptions =
  | { store: SnapshotStore; root?: never }
  | { store?: never; root?: string };

/** Replay one Lookout-emitted durable reference without any network access. */
export async function resolveLookoutSnapshot(
  reference: string,
  options: ResolveLookoutSnapshotOptions = {},
): Promise<SnapshotSourceRefResolution> {
  try {
    const store = options.store ?? createLookoutSnapshotStore(options.root);
    return await resolveSnapshotSourceRef(store, reference);
  } catch {
    return {
      ok: false,
      error: {
        kind: "snapshot-store-error",
        message: "the supplied snapshot store could not resolve the reference",
      },
    };
  }
}
