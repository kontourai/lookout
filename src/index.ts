export { runCli } from "./cli.js";
export type { RunCliOptions } from "./cli.js";
export { createCheckRunner } from "./check-runner.js";
export type { CheckRunner, CreateCheckRunnerOptions, FetchSource } from "./check-runner.js";
export type {
  ChangedResult,
  CheckResult,
  CheckResultCommon,
  ErrorResult,
  LookoutErrorKind,
  Unchanged304Result,
  UnchangedHashResult,
} from "./check-result.js";
export { defaultProviderResolver } from "./provider-resolution.js";
export type { ProviderResolver } from "./provider-resolution.js";
export {
  loadRegistry,
  LookoutRegistry,
  parseRegistry,
  RegistryValidationError,
} from "./registry.js";
export type {
  ExtractableLookoutSource,
  LookoutRegistryDocument,
  LookoutSource,
  LookoutSourceKind,
  RenderPolicy,
  StructuredFileFormat,
  StructuredFileLookoutSource,
} from "./registry.js";
export {
  createLookoutSnapshotStore,
  resolveLookoutSnapshot,
} from "./snapshot-store.js";
export type { ResolveLookoutSnapshotOptions } from "./snapshot-store.js";
export type { SnapshotSourceRefResolution } from "@kontourai/forage/fetch";
export { canonicalValueKey } from "./canonical-value.js";
export type {
  CanonicalValueKey,
  CanonicalValueFormatVersion,
  CanonicalValueResult,
  DiffKernelError,
  DiffKernelErrorKind,
  DiffResult,
  IdentityResult,
} from "./canonical-value.js";
export { compareStructural, diffKeyedMultiset } from "./structural-diff.js";
export type {
  KeyedMultisetFacts,
  KeyedMultisetOptions,
  StructuralComparison,
  StructuralComparisonOptions,
  StructuralFacts,
} from "./structural-diff.js";
export { diffProposalSets, extractionProposalIdentity } from "./proposal-diff.js";
export type {
  FieldChangedEvent,
  FieldChangeKind,
  NewEntityAppearedEvent,
  ProposalDiffEvent,
  ProposalEvidence,
  ProposalIdentity,
  ProposalOccurrencePair,
  ProposalSetDiff,
  ProposalSetDiffInput,
  ProposalSetFacts,
  ProposalSetObservation,
  ProvenanceChangeFact,
} from "./proposal-diff.js";
export { createObservationStore } from "./observation-store.js";
export type { CreateObservationStoreOptions, ObservationCheckAnchor, ObservationStore, ObservationStoreError, ObservationStoreErrorKind, ObservationStoreResult, ProposalObservationRecordInput, StoredProposalObservationV1 } from "./observation-store.js";
export { createDriftEmitter } from "./drift-emission.js";
export type { BaselineEstablishedFact, CreateDriftEmitterOptions, DriftEmitter, DriftError, DriftErrorKind, DriftFact, DriftResult, DriftSuccess, EmitDriftInput } from "./drift-emission.js";
export { checkSchemaCoverage } from "./coverage.js";
export type { SchemaCoverageGap, SchemaCoverageResult } from "./coverage.js";
export { createObserveExtractDiff } from "./observe-extract-diff.js";
export type {
  ObserveExtractAcquisition,
  ObserveExtractAttempt,
  ObserveExtractDiff,
  ObserveExtractDiffOptions,
  ObserveExtractError,
  ObserveExtractErrorKind,
  ObserveExtractExtraction,
  ObserveExtractExtractionInput,
  ObserveExtractObservation,
  ObserveExtractObservationIdentity,
  ObserveExtractOutcome,
  ObserveExtractProviderFailure,
  ObserveExtractRecorder,
  ObserveExtractResult,
  ObserveExtractSource,
  ObserveExtractSourceSnapshot,
} from "./observe-extract-diff.js";
export { buildSemanticReviewWork, semanticReviewApiVersion } from "./semantic-review-work.js";
export type {
  BuildSemanticReviewWorkInput,
  SemanticClaimTarget,
  SemanticObservationIdentity,
  SemanticReviewCandidate,
  SemanticReviewChange,
  SemanticReviewItem,
  SemanticReviewKind,
  SemanticReviewWork,
} from "./semantic-review-work.js";
