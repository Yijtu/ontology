# Rule support provenance resolution (2026-09-28)

`SupportEvidenceDependencySource` always returns the evidence-to-evidence edges already stored
in an evidence envelope. It only adds `origin: support` edges when an injected
`PublishedRuleSupportReader` returns one complete immutable support instance for the exact
`ruleRef`, `validAt`, and `recordedSeq` carried by that evidence. The selected instance and each
premise fact must agree on tenant/space, subject entity, object, and definition pin. Only
`entity_attribute` facts are accepted, and source edges are made only to their original evidence
references. The fact's `sourceStatementId` remains available to the caller as the parent of the
attribute projection. The read request also carries the exact root `evidenceRef` and optional
immutable `payloadRef`, allowing the artifact reader to locate instance metadata in the
root payload instead of enumerating same-rule entities and guessing.

The root evidence contract currently carries a `ruleRef` but no entity-instance key. If the
immutable reader finds multiple matching instances, the result is `ambiguous` and no support
edges are emitted. A missing reader, missing recorded sequence, incomplete read, non-applicable
rule, unknown/conflicting applicability, or mismatched fact produces a typed resolution status
and no inferred support edges; unknown and conflict remain distinct from not-applicable. The
legacy `PublishedSemanticReadView` option remains accepted for composition compatibility, but
current published heads are never evaluated as a provenance fallback. In particular, a latest
source snapshot is not a substitute for the historical source state that existed when evidence
was produced.

`dependenciesWithResolutionOf` exposes the resolution status. The older
`dependenciesOf` port method remains edge-only for existing provenance service composition; an
empty support edge list from that method must not be presented as proof that the support DAG was
fully reconstructed. `ProvenanceReadService` reports `supportResolution` and per-node
`coverage.support` separately from artifact integrity; missing nodes, unknown/conflicting
support, depth boundaries and continuation pages never silently prove a complete graph.

## Materialized reader checkpoint (2026-09-29)

`MaterializedRuleSupportReader` is now injected by the PostgreSQL provenance composition.
It reads append-only `ProjectionSlice` records through `MaterializationStore`, validates the
stored `RuleComputationArtifact@1` and its computation digest, and uses the saved premise groups.
It never evaluates current publication heads. An exact immutable payload can select one entity
instance; without that locator, multiple matching instances remain ambiguous.

Reads are bounded to 10,000 slices and 256 evidence references with concurrency four. Supporting
references must match archived records by their complete kind/id/version/digest. Raw chunk or
document references remain genuine source references, but cannot by themselves establish a
complete evidence-to-evidence DAG under this contract.

Payload metadata is authorized and checked before reading bytes. JSON payloads are limited to
1 MiB, decoded as strict UTF-8 and checked against the recorded byte length and SHA-256. An
oversized payload is not read and cannot select an instance; multiple candidates still remain
ambiguous. Valid-time interval checks compare UTC instants at nanosecond precision.

Root independently ran the reader, producer, consumer and architecture tests: five files,
35 passing tests. The two existing PostgreSQL provenance/history positive suites are still
being updated to obtain legal immutable slices from the real materializer; this checkpoint
does not claim those suites or the complete rule-answer product flow have passed. The normal
rule evidence producer still needs to archive its exact per-instance artifact and original
source evidence so the native raw-document path can expose a complete support DAG.
