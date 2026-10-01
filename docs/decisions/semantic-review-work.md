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

An excerpt only narrowed around a value that stayed put is not a move. The
pair raises no item when all of these hold: the two proposals carry the same
non-empty string value; both locators are well-formed `chars:` spans that the
resolver, when it ran, settled on; the current span lies strictly inside the
prior span with the same text there, so nothing is newly cited; only whole
paragraphs were dropped, meaning a blank line (two or more line breaks, in any
CR/LF spelling, with at most whitespace between) separates the dropped text
from what is kept, so a hard-wrapped sentence is never cut; the value is first found at the same absolute
offset in both excerpts and is not the inside of a longer word or number in
either; and resolver version and ambiguity are unchanged. Such a pair is listed
in the diff's `excerptBoundaryChanges` fact with the text dropped before and
after, and the exact occurrence facts still list both locators.

Everything else is one moved or provenance-changed item: any widening or shift
(it cites text the prior did not, which can negate or re-scope the value), a
narrowing that drops text not set off by a blank line (the rest of the value's
line, or the line above or below it), a value at another
offset or a different occurrence, a changed match count, selected index or
selected span, a non-string or derived value, or a locator that does not
describe its excerpt. No cue-word list is used; the rule is structural. Its
accepted limit is what stays quiet: a dropped paragraph, such as a heading set
off by a blank line above the value, raises no item even when that paragraph
scopes the value. That text is carried in the fact for consumers that want to
review it.

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
