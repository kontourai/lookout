# @kontourai/survey API reference (v1.5.0) — for lookout L3

Published to npm: `"@kontourai/survey": "^1.5.0"`. `type: module`. Test runner: `node --test`.
`SURVEY_INPUT_CONTRACT_VERSION = "1"`.

## Imports

```typescript
import {
  SurveyInputBuilder, buildSurveyTrustBundle,
  fieldObservation, repeatedObservation,
  webPageSource, apiRecordSource, manualEntrySource,
  SURVEY_INPUT_CONTRACT_VERSION,
  type SurveyInput, type RawSource, type Extraction, type Candidate,
  type CandidateSet, type ReviewOutcome, type ClaimTarget,
} from "@kontourai/survey";
```

## Core record shapes

```typescript
interface RawSource {
  id: string;
  kind: "uploaded-document" | "web-page" | "api-record" | "manual-entry"
      | "policy-standard" | "inquiry-question" | "agent-utterance" | "system-schema";
  sourceRef: string;               // use traverse's snapshot-anchored ref here
  observedAt: string;              // ISO
  fetchedAt?: string; checksum?: string; // checksum normalizes "abc" -> "sha256:abc"
  locatorScheme: "pdf" | "text" | "html" | "structured-field" | "text-span";
  inlineText?: string; metadata?: Record<string, unknown>;
}
interface Extraction {
  id: string; sourceId: string; target: string; value: unknown;
  confidence?: number;             // 0..1
  locator?: string;                // REQUIRED for non-manual-entry sources when projecting to Surface
  excerpt?: string; extractor: string; extractedAt: string;
  metadata?: Record<string, unknown>;
}
interface Candidate { id: string; extractionId: string; value: unknown; confidence?: number; sourceRank?: number; rejectionReason?: string; metadata?: Record<string, unknown>; }
interface CandidateSet {
  id: string; target: string; candidates: Candidate[];
  selectedCandidateId?: string;
  status: "resolved" | "needs-review" | "conflict" | "escalated";
  rationale?: string; metadata?: Record<string, unknown>;
}
interface ReviewOutcome {
  id: string; candidateSetId: string; candidateId?: string;
  status: "verified" | "assumed" | "rejected" | "proposed";
  actor?: string; reviewedAt?: string; rationale?: string;
  evidenceIds?: string[]; withinComfortZone?: boolean; metadata?: Record<string, unknown>;
}
interface ClaimTarget {
  id: string; candidateSetId: string; candidateId?: string;
  subjectType: string; subjectId: string; facet: string;
  claimType: string; fieldOrBehavior: string; value?: unknown;
  impactLevel: ImpactLevel;        // e.g. "medium"
  collectedBy: string;             // producer identifier
  createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown>;
}
interface SurveyInput {
  contractVersion?: string;        // set to SURVEY_INPUT_CONTRACT_VERSION explicitly
  source: string;                  // producer id, e.g. "lookout:run-<id>"
  generatedAt: string;             // ISO
  rawSources: RawSource[]; extractions: Extraction[];
  candidateSets: CandidateSet[]; reviewOutcomes: ReviewOutcome[];
  claims: ClaimTarget[];
  escalations?: EscalationRecord[]; interpretations?: Interpretation[];
}
```

## Builder

```typescript
new SurveyInputBuilder({ source: string, generatedAt?: string, contractVersion?: string })
  .addRawSource(r).addExtraction(e).addCandidateSet(cs)
  .addReviewOutcome(ro).addClaim(c)
  .addObservation(obs) // from fieldObservation()/repeatedObservation()
  .build(): SurveyInput
// build() throws on duplicate IDs within a collection; idempotent re-add allowed
// only for structurally identical raw sources.
```

Raw-source factories (default locatorScheme): `webPageSource(...)` → "html", `apiRecordSource(...)` → "structured-field", `manualEntrySource(...)` → "structured-field".

## Projection

```typescript
function buildSurveyTrustBundle(input: SurveyInput, options?: { reviewProofs?: boolean }): TrustBundle
// -> @kontourai/surface TrustBundle { schemaVersion: 5, source, claims, evidence, policies: [], events }
```

Validation it enforces (THROWS on violation):
- every claim.candidateSetId / candidate.extractionId / extraction.sourceId must resolve;
- claim.candidateId must exist in its CandidateSet.candidates;
- extraction.locator REQUIRED unless the raw source kind is manual-entry;
- review-status discipline checks.

## Minimal valid SurveyInput (passes buildSurveyTrustBundle)

```typescript
const input: SurveyInput = {
  source: "survey.minimal.example", generatedAt: "2026-05-31T16:00:00.000Z",
  rawSources: [{ id: "source-1", kind: "web-page", sourceRef: "https://example.test/page",
                 observedAt: "2026-05-30T18:00:00.000Z", locatorScheme: "html" }],
  extractions: [{ id: "extraction-1", sourceId: "source-1", target: "status", value: "ACTIVE",
                  confidence: 0.9, locator: "html:field=status", excerpt: "Status is ACTIVE.",
                  extractor: "example-extractor", extractedAt: "2026-05-30T18:00:00.000Z" }],
  candidateSets: [{ id: "candidates-1", target: "status", selectedCandidateId: "candidate-1",
                    status: "resolved",
                    candidates: [{ id: "candidate-1", extractionId: "extraction-1", value: "ACTIVE", confidence: 0.9 }] }],
  reviewOutcomes: [{ id: "review-1", candidateSetId: "candidates-1", candidateId: "candidate-1",
                     status: "verified", actor: "reviewer", reviewedAt: "2026-05-30T18:05:00.000Z",
                     rationale: "Verified the field." }],
  claims: [{ id: "claim-1", candidateSetId: "candidates-1", candidateId: "candidate-1",
             subjectType: "entity", subjectId: "entity-123", facet: "profile",
             claimType: "field-data", fieldOrBehavior: "status", value: "ACTIVE",
             impactLevel: "medium", collectedBy: "example-extractor" }],
};
const bundle = buildSurveyTrustBundle(input); // 1 claim, 1 evidence, 1 event
```

Mapping notes for lookout: traverse `ExtractionProposal.provenance.locator` ("chars:<a>-<b>") goes into `Extraction.locator`; the snapshot-anchored sourceRef goes into `RawSource.sourceRef`; use `RawSource.checksum = "sha256:<bodyHash>"`; a lookout event that has NOT been human-reviewed should produce `CandidateSet.status: "needs-review"` and NO ReviewOutcome (or `status: "proposed"`), never "verified".
