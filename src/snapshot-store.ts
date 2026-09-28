import path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import type { SnapshotStore } from "@kontourai/forage";
import {
  resolveSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";

export interface LookoutSnapshotStoreOptions {
  /**
   * Per-source record ceiling, passed to Forage's filesystem store (1 to
   * 10,000; Forage's default is 10,000). It cannot change after a source's
   * store directory is initialized.
   */
  readonly maxHistoryFiles?: number;
}

export function createLookoutSnapshotStore(
  root = path.join(process.cwd(), ".kontourai", "lookout", "snapshots"),
  options: LookoutSnapshotStoreOptions = {},
): SnapshotStore {
  return createFilesystemSnapshotStore({
    root,
    ...(options.maxHistoryFiles === undefined ? {} : { maxHistoryFiles: options.maxHistoryFiles }),
  });
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
