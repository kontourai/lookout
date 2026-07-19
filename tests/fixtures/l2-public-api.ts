import type { ExtractionProposal } from "@kontourai/traverse";
import {
  canonicalValueKey,
  compareStructural,
  diffKeyedMultiset,
  diffProposalSets,
  extractionProposalIdentity,
} from "../../src/index.js";
import type {
  CanonicalValueKey,
  CanonicalValueFormatVersion,
  CanonicalValueResult,
  DiffKernelError,
  DiffResult,
  FieldChangedEvent,
  IdentityResult,
  KeyedMultisetFacts,
  NewEntityAppearedEvent,
  ProposalDiffEvent,
  ProposalIdentity,
  ProposalSetDiff,
  ProposalSetObservation,
  StructuralComparison,
  LookoutSource,
  StructuredFileLookoutSource,
} from "../../src/index.js";

const proposal: ExtractionProposal = {
  fieldPath: "records[].label",
  pathIndices: [0],
  candidateValue: "Example",
  confidence: 0.9,
  provenance: { excerpt: "Example", locator: "chars:0-7" },
  extractor: "fixture-extractor:v1",
};

const observation: ProposalSetObservation = {
  sourceId: "source-example",
  snapshotRef: "snapshot-example",
  observedAt: "2026-07-10T00:00:00.000Z",
  proposals: [proposal],
};

const canonical: CanonicalValueResult = canonicalValueKey({ label: "Example" });
const canonicalKey: CanonicalValueKey | undefined = canonical.ok ? canonical.key : undefined;
const canonicalFormat: CanonicalValueFormatVersion = "lookout-canonical-v1";
const canonicalError: DiffKernelError | undefined = canonical.ok ? undefined : canonical.error;

const identity: IdentityResult<"entity-example"> = { ok: true, key: "entity-example" };
const exactIdentity: IdentityResult<ProposalIdentity> = extractionProposalIdentity(proposal);
const structural: StructuralComparison<{ value: unknown; provenance: unknown }> = compareStructural(
  { value: "old", provenance: { locator: "chars:0-3" } },
  { value: "new", provenance: { locator: "chars:4-7" } },
  {
    value: (item: { value: unknown; provenance: unknown }) => item.value,
    provenance: (item: { value: unknown; provenance: unknown }) => item.provenance,
  },
);
const multiset: DiffResult<KeyedMultisetFacts<string, string>> = diffKeyedMultiset(
  ["a", "a"],
  ["a", "b"],
  { identity: (value: string) => value },
);
const proposalDiff: DiffResult<ProposalSetDiff> = diffProposalSets({
  prior: observation,
  current: observation,
  selectEntities: (input: ProposalSetObservation) => [input.proposals],
  entityIdentity: () => identity,
  proposalsFor: (entity: readonly ExtractionProposal[]) => entity,
  fieldIdentity: (_entity: readonly ExtractionProposal[], item: ExtractionProposal) => item.fieldPath,
});

declare const appearance: NewEntityAppearedEvent;
const change: FieldChangedEvent = {
  kind: "field-changed",
  entityKey: "entity-example",
  fieldKey: "records[].label",
  changeKind: "value-populated",
  current: {
    sourceId: "source-example", snapshotRef: "snapshot-example", observedAt: "2026-07-10T00:00:00.000Z",
    entityKey: "entity-example", fieldKey: "records[].label", value: "Example", confidence: 0.9,
    provenance: proposal.provenance, extractor: proposal.extractor, fieldPath: proposal.fieldPath,
  },
};
const optionalChangeSides: readonly unknown[] = [change.prior, change.current];
const events: readonly ProposalDiffEvent[] = [appearance, change];

const structuredSource: StructuredFileLookoutSource = {
  id: "published-results",
  kind: "structured-file",
  format: "json",
  url: "https://example.test/results.json",
  cadenceHint: "daily",
};
const sourceUnion: LookoutSource = structuredSource;
// @ts-expect-error Structured files cannot carry extraction or render fields.
const invalidStructuredSource: LookoutSource = {
  ...structuredSource,
  targetSchema: [],
  renderPolicy: "never",
};

void [canonicalKey, canonicalFormat, canonicalError, exactIdentity, structural, multiset, proposalDiff, events, optionalChangeSides, sourceUnion, invalidStructuredSource];
