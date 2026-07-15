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
  LookoutRegistryDocument,
  LookoutSource,
  LookoutSourceKind,
  RenderPolicy,
} from "./registry.js";
export { createLookoutSnapshotStore } from "./snapshot-store.js";
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
export { createSurveyEmitter } from "./survey-emission.js";
export type { BaselineEstablishedFact, CreateSurveyEmitterOptions, EmissionError, EmissionErrorKind, EmissionFact, EmissionResult, EmissionSuccess, EmitSurveyInput, SurveyEmitter } from "./survey-emission.js";
export { checkSchemaCoverage } from "./coverage.js";
export type { SchemaCoverageGap, SchemaCoverageResult } from "./coverage.js";
