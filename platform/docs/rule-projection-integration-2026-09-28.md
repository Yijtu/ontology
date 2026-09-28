# Rule projection integration note (2026-09-28)

This note records the pure rules-module contract for C2. The publication store, outbox worker,
materializer, and public `RuleComputationArtifact` remain owned by the integration layer.

## Attribute facts

Use `projectPublishedAttributeFacts(statements, { schemaRef })` for production reads. It preserves
each parent statement as the provenance and invalidation anchor and emits one `RuleFact` for every
valid `value.attributes[]` entry. The projected fact carries the canonical entity in `subject`,
its type in `objectId`, `attributeId` as `predicate`, exact amount/unit, statement validity and
recorded version, status, schema pin, original `sourceRefs`, and `sourceStatementId`.

For one attribute, the stable logical assertion key is
`<statementId>#<encoded-attributeId>`. Its immutable version key is
`<statementId>#<encoded-attributeId>@<encoded-version>`. If one parent contains duplicate entries
for the same attribute, each gets a deterministic occurrence suffix and the projection returns a
`DUPLICATE_ATTRIBUTE_ID` issue. The facts are kept so the evaluator can report a conflict rather
than silently dropping a value. Active later statement versions use `correct`; a retracted
statement version uses `retract` while keeping the same logical assertion key.

`RuleFactRef` carries the parent `sourceStatementId` and copied source refs. The outbox still
names the parent statement ID, so the worker must expand a parent change to every projected
attribute fact whose `sourceStatementId` matches it, then invalidate dependent rule-instance
keys. A projected child ID must never replace the parent as the sole outbox dependency key.
Provenance for any derived support should include both the parent statement reference and the
individual attribute projection identity.

`ruleFactsFromStatements` remains as a compatibility helper for old callers. It does not expose
projection issues; materialization should consume the projection object so it can retain those
diagnostics.

## Exact values

An attribute with no `unitCode` and a string value is categorical. A string value with a unit must
be a decimal lexical form; it is normalized to a plain exact decimal string and paired with that
unit. Scientific notation and surrounding whitespace are accepted and canonicalized. For example,
`" 001.2500 "` with unit `h` becomes `{ amount: "1.25", unit: "h" }`, and `"1.25e2"` becomes
`{ amount: "125", unit: "h" }`. A nested `{ amount, unit }` is also accepted when its unit agrees
with any sibling `unitCode`.

Malformed decimals, malformed units, mismatched nested/sibling units, non-finite numbers, unsafe
integer numbers, and numeric values without a unit become unknown facts with a typed projection
issue. Numeric values already decoded as JavaScript numbers are canonicalized from their shortest
decimal string; sources that need to preserve every source decimal digit should send a decimal
string with a unit (or a nested exact quantity). The rule module does not convert between units:
the schema/mapping layer must provide one canonical unit before evaluation. A rule whose expected
unit does not match an observed quantity remains unknown.

## Rule instances and applicability

Use `compilePublishedRuleInstances(ruleVersions, facts, { scopeRef, definitionRef, subjects,
completeRangeAttributeIds? })`. Subjects are explicit confirmed `(subjectEntityId, objectId)` pairs.
Each emitted instance reads facts matching that exact entity, object type, and definition version.
Instance and applicability keys include tenant, space, definition, exact published rule reference,
object type, and subject entity. The published `ruleRef` uses the immutable `ruleVersionId`,
canonical content digest, and SemVer-encoded `VersionRef.version`. The current published revision
is a canonical non-negative integer, so revision `1` serializes as `1.0.0`; `logicalRuleId`,
`ruleVersionId`, and raw `publishedRevision` remain separate metadata fields. Noncanonical
revision strings become per-rule typed capability issues instead of being passed off as SemVer.

The bounded compiler supports `all`, `compare`, `range`, same-condition `any`, and finite `not`
over a present observation or a configured complete-range attribute. A published exception is
attached to its rule and is represented as `condition AND NOT(exception)`. Each exception must be
one comparison, range, or same-condition `any`; a composite exception that cannot be faithfully
represented, a relation premise, or a mixed-condition `any` returns a typed issue for that rule
and subject. Other valid rules still compile. The issue retains the source rule reference and AST
spans for publication preflight.

Evaluation appends `applicabilities[]` to the pure result. Each row includes the scope, exact rule
reference, subject/object, definition, valid-time and recorded-time view, condition and exception
states, premise fact refs, parent statement IDs, source AST spans, input/computation digests, and
whether the upstream input was complete; callers must set `complete: true` only after all relevant
pages are loaded (omission is incomplete). Applicability is one of `applicable`, `not_applicable`,
`unknown`, or `conflict`. `positiveSupport` is true only for `applicable`.

These results express rule applicability and support only. The compiler uses a synthetic,
entity-qualified `rule.applicability` key because `PublishedRuleVersion` has no explicit business
consequence. It must not be rendered as a domain action such as “inspection required.” The public
integration may bind a reviewed explicit consequence elsewhere. `condition=false` or
`exception=true` yields no positive support and leaves the corresponding business proposition
unknown unless another rule/source supports it or a separate formal refutation exists. Conflicting
premises remain conflicts; an independently valid OR support can remain positive.

The old `supportRuleFromPublishedRule` single-rule helper remains for compatibility only when the
rule has no exceptions and the relevant facts identify at most one subject. It throws a typed
error for attached exceptions or multiple subjects, and its `VersionRef.id` remains the logical
rule ID for existing provenance lookups. Its digest is content-derived and its version uses the
SemVer serialization above. New publication reads must use the multi-instance compiler and consume
`applicabilities`.
