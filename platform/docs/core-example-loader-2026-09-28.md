# Core example configuration loader (2026-09-28)

The default API host can load the local synthetic examples with a trusted scope:

```ts
import { loadCoreExamples } from './composition/core-example-loader'

const { scenarios } = loadCoreExamples({ targetScopeRef })
```

`indexPath` is optional; by default it resolves to `deploy/core/examples/index.json`. The
loader resolves every asset path relative to the index, rejects traversal and symlinks that
escape the example directory, and applies a byte cap before reading files. It validates
contract-backed refs and `IndustryManifest` with the published contract schemas; validates
and scope-binds each `SemanticDefinitionVersionDraft`, then computes its canonical ref and
projects the `IndustrySchema`; checks source-agnostic mapping templates, policy/test-suite
content refs and full `SemanticMapping` refs; and validates physical mapping fields/links
against that projected schema.

Each returned scenario has `scenarioId`, `label`, `profileRef`, `namespace`,
`industryManifest`, target-scoped `definitionDraft`, `definitionRef`, projected
`industrySchema`, `mappingTemplates`, `physicalMappings` (`mapping`, exact `ref`, resolved
`path`), `rawSources` (`sourceRef`, resolved `path`, `mediaType`), a separate
`syntheticPolicy` source, `testSuite`, and the golden/calibration entity IDs. Policy documents
are separate inputs and are deliberately not required to appear in `rawSources`.

The loader returns declarations and input paths only. It does not create demo profile rows,
register source records, publish definitions, seed candidates/identities/facts/answers, or start
document/model/worker execution. The host owns those normal flows and decides how each profile
is assembled. The unit test validates the default index and refuses a traversal path; the raw
record and policy parser/pipeline coverage lives in `tests/unit/core-example-assets.spec.ts`.
