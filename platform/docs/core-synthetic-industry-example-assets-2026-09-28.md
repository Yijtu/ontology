# Core synthetic industry demo assets (2026-09-28)

`deploy/core/examples/index.json` is the mount index. It declares two example `profileRef`s,
labels and namespaces, the existing `IndustryManifest` and `SemanticDefinitionVersionDraft`
files, plain-text raw sources and their distinct `SourceRef`s, synthetic policy documents, and
versioned `SemanticMapping` files. The examples are public synthetic data, not real facilities,
industrial assets, regulations, standards or customer policy. Their `standardProvenance` is
`synthetic_assumption` for that reason.

The industry definition drafts contain only semantic object/attribute/relation/identity
declarations. Rule constraints stay empty. Their `inspection_required` and
`maintenance_required` attributes name typed consequences for rules that still must enter via
policy parsing, extraction candidates, review and publication. The local draft files carry the
default Core demo scope; a host mounting them elsewhere must replace `scopeRef` with the trusted
target scope before publication. The definition content digest is scope-independent and is
checked with the existing `definitionVersionDigest` function.

Raw `.txt` source files are UTF-8 plain text with one JSON object per blank-line-delimited
record. They can be passed to `LocalDocumentExtractionService` using `text/plain`, then through
the existing native JSON record path in `ExtractionPipeline`. The transport `registry-a` and
`field-review-b` documents both contain T-01 `inspection_due=true`, but have distinct
`SourceRef`s, content and `source_record_id`s. They are independent supports; the demo does not
pre-confirm that the records refer to the same entity. A reviewer must explicitly confirm
identity before treating them as one entity's OR support.

Golden record values follow the acceptance file: T-01 is true/false; T-02 true/true; T-03 and
T-05 omit exemption; T-04 has due=false; T-06 omits due. I-01 is 120 h/false; I-02 120 h/true;
I-03 90 h/false; I-04 100 h/false; I-05 omits hours; I-06 omits exemption. Missing JSON keys
remain absent. Neither the schema nor parser supplies false or zero defaults.

Industrial `minutes-layout.json` maps `asset_key` to `asset_id`, `network_key` to
`asset_network_code`, `accumulated_minutes` to `operating_hours` with `unitFactor: 60`, and
`waiver_flag` using 0→false and 1→true. In `SemanticMapping`, `unitFactor` is physical units per
canonical unit, so 6000 / 60 is exactly 100 h; 5999 is strictly below the 6000-minute threshold.
`I-CAL-5999` is explicitly a conversion-boundary probe, not part of the I-01–I-06 golden set.
The minutes source remains a distinct physical layout; its fixture parser test does not pretend
that the unfinished Core data adapter has executed this mapping.

The policy text files describe only R-T and R-I as synthetic local assumptions. The asset unit
test sends controlled responses through the ordinary parser and `ExtractionPipeline`, asserting
that those rules become pending-review candidates with typed conclusions and attached
exceptions. It does not publish them. No candidate, identity assertion, published statement,
derived fact, verification, or answer is seeded by these files.

The focused unit suite validates the definition drafts, industry manifests, `MappingTemplate`s,
mapping digests and identifiers, parses raw files with the real local document parser, produces
and validates native entity candidates, and exercises the controlled rule-extraction path. It
does not establish Core host mounting, source adapters, identity review, normal publication or
real customer-data quality; those remain normal API/worker acceptance steps.
