---
status: current
subject: Deterministic semantic proposal transitions as source-linked review work
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/24
  - kind: doc
    ref: src/semantic-review-work.ts
---
# Deterministic semantic proposal transitions as source-linked review work

## Decision

`buildSemanticReviewWork` is a pure, additive projector over one genuine pair
of proposal observations. It reuses Lookout's caller-injected entity and field
identity capabilities and emits structurally Survey-compatible `ReviewItem`
resources. Survey is a development-only compatibility contract, not a runtime
dependency. Lookout continues to choose no review resolution, escalation,
supersession, authority, or persistence policy.

The semantic vocabulary is deliberately closed: proposal added, removed,
moved, provenance changed, or value changed; newly introduced schema-coverage gap; and newly
introduced exact-provenance gap. A changed source whose complete proposal set
is stable emits no work. A removal has a prior evidence candidate and an
explicit absent current candidate anchored to the new snapshot. Additions use
the inverse representation. Two-sided changes retain both exact snapshot,
observation-time, locator, excerpt, confidence, extractor, entity, and field
anchors.

Transition identity binds the source and both caller-provided observation
identities. Item identity additionally binds the complete semantic change and
its deterministic occurrence number, preserving multiplicity without identity
collisions.
Neither uses time nor randomness, so replay is byte-for-byte idempotent. The
projector rejects empty or credential-shaped observation identities, contains
caller callback failures, and copies no raw source body, provider response,
provider message, native diagnostic, or free-form warning. Excerpts and claim
targets can still be sensitive and require consumer-owned retention, redaction,
and access controls.

The diff facts now include observation-anchored evidence for added and removed
occurrences. This is the reusable learning from the slice: raw proposal facts
were insufficient to review a removed entity because its old snapshot and
observation identity had already been discarded. Keeping the evidence alongside
the occurrence fixes that abstraction for every downstream consumer without
making the diff kernel depend on review vocabulary.

## Boundary

Lookout owns deterministic semantic classification and evidence-preserving
review-work shaping. Traverse owns proposal and schema contracts. Survey owns
the review resource contract. Consumers own claim meaning, review policy,
storage, delivery, and authorization.
