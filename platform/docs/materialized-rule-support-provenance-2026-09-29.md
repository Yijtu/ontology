# Materialized rule-support provenance (2026-09-29)

`MaterializedRuleSupportReader` reads append-only `ProjectionSlice` records through the
`MaterializationStore` port. It does not load current published facts/rules or re-run a rule. For
each slice at the requested valid time and recorded sequence, it uses the exact
`RuleComputationArtifact@1` stored in `conclusion.ruleArtifacts`, together with the conclusion's
`satisfiedBy` groups, to map supporting attribute-child assertion IDs back to their parent
`sourceStatementId` and original `sourceRefs`.

The reader accepts a candidate only when tenant/space, ruleRef, validAt, recorded sequence,
scope, artifact self-digest, and applicability data match. It reads at most 10,000 slices per
request. Every support fact must have a parent statement and only evidence ResourceRefs; the
reader checks at most 256 unique full evidence refs, four at a time, and compares each referenced
envelope's id/version/digest/kind. A document/chunk/source ref without a corresponding evidence
envelope is real provenance, but the current evidence-to-evidence graph cannot traverse it, so
support coverage is incomplete instead of silently omitting that source. Unsupported negative
premises outside the attached-exception mapping also fail closed.

An evidence envelope carries `ruleRef`, `recordedSeq`, and validity, but has no entity-instance
key. If one immutable materialized instance matches the exact time/version tuple, the reader can
resolve it. If several entities match, it reports ambiguity unless `payloadRef` contains a direct
JSON serialization of the matching materialized `RuleComputationArtifact@1`; its full canonical
digest and instance key must match the persisted slice. Such a payload is authorized through the
injected metadata reader before any byte read, capped at 1 MiB, UTF-8/JSON parsed, and checked
against its content digest. Oversized payload bodies are never read; a uniquely matched persisted
slice remains usable, while multiple instances stay ambiguous.

The normal `IncrementalMaterializer` already writes per-instance artifacts into immutable
projection slices, and the PostgreSQL provenance fixtures now drive that materializer before
reading. The application does not yet have a general `rule_derivation` evidence producer that
archives one selected per-instance artifact and records it in an evidence envelope. Until that
producer is wired, evidence without a unique rule/entity/time instance remains ambiguous. A future
producer can serialize the exact `RuleComputationArtifact` emitted with its materialized conclusion,
store those bytes with the authorized immutable artifact writer, and put the returned ref on
`EvidenceEnvelope.payloadRef`; it must retain the source materializer's exact `ruleRef`, `validAt`,
and `asOfRecordedSeq` rather than substituting current heads.
