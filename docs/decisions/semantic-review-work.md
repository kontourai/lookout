---
status: current
subject: Deterministic semantic proposal transitions as source-linked review work
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/24
  - kind: issue
    ref: https://github.com/kontourai/lookout/issues/105
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

One field change is one item. A retained field whose value changed and whose
citation also moved is a single value-changed item carrying both sides'
locators and excerpts; the move stays a provenance fact in the diff. A changed
value whose new citation has no locator or excerpt still gets its own
provenance-gap item.

Provenance equality is the resolved occurrence. `occurrence.selection` and
`occurrence.hintUsed` record only whether a provider sent an optional
occurrence hint, so two runs that resolve the same span, index, match count and
ambiguity are equal whatever steered them there. Every other resolver fact is
still compared.

An excerpt re-cut around a value that stayed put is not a move. When two
proposals of one field carry the same string value, well-formed `chars:`
locators, identical text wherever their excerpts overlap, and the value first
found at the same absolute offset in both, the cited value is at the same place
and the model only quoted more or less context. That pair raises no item and is
listed in the diff's `excerptBoundaryChanges` fact; the exact occurrence facts
still list both locators. The rule is deliberately narrow: a value at another
offset, a different occurrence, differing overlap text, a non-string or derived
value the excerpt does not literally contain, a locator that does not describe
its excerpt, or a change in resolver version or ambiguity is reported as one
moved or provenance-changed item. Text that only one of the two excerpts quotes
is outside what both runs cited, exactly as text outside an unchanged excerpt
is.

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
