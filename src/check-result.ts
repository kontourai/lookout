import type { FetchError } from "@kontourai/traverse/fetch";

export interface CheckResultCommon {
  sourceId: string;
  sourceUrl: string;
  checkedAt: string;
  warnings: string[];
}

export interface Unchanged304Result extends CheckResultCommon {
  kind: "unchanged-304";
  snapshotRef: string;
}

export interface UnchangedHashResult extends CheckResultCommon {
  kind: "unchanged-hash";
  priorSnapshotRef: string;
  currentSnapshotRef: string;
}

export interface ChangedResult extends CheckResultCommon {
  kind: "changed";
  priorSnapshotRef: string | null;
  currentSnapshotRef: string;
  changeBasis: "initial" | "hash";
}

export type LookoutErrorKind =
  | "prior-read"
  | "persistence"
  | "dependency-contract"
  | "unexpected";

export interface ErrorResult extends CheckResultCommon {
  kind: "error";
  origin: "traverse" | "lookout";
  error: FetchError | { kind: LookoutErrorKind; message: string };
}

export type CheckResult = Unchanged304Result | UnchangedHashResult | ChangedResult | ErrorResult;
