# JEV System One adapter integration

The JEV adapter uses TypeSafe's documented System One API as its default and only wire protocol. It sends `POST /v1/systemone` with the configured vendor model, the resolved actual state, and a map of typed questions. It does not send the old `/v1/decide` `state_ref`/`results` format and has no automatic legacy fallback.

The request and answer shapes follow the current [API reference](https://docs.typesafe.ai/api). State is the material being evaluated; question prompts and supporting facts must not be replaced with a hash or claim identifier ([State](https://docs.typesafe.ai/concepts/state)). Choice criteria map option ids to descriptions ([Choice](https://docs.typesafe.ai/primitives/choice)); intent-routing guidance treats the returned probabilities and confidence as routing evidence, with application code retaining the actual routing decision ([Intent routing](https://docs.typesafe.ai/patterns/intent-routing)).

## Host state resolver

Construct `JevDecisionAdapter` with a host-owned `stateResolver`. The resolver receives the original `DecisionRequest.stateRef`, byte/record limits, an abort signal, and the trusted `ToolContext`. It must read the immutable state revision through the authorized artifact or run-state service. It must enforce the tenant, space, principal, and resource scope from `ToolContext`; the adapter also checks that the resource kind is allowed, that the resolved ref exactly matches id/version/digest/kind, that the state is complete JSON, and that its canonical UTF-8 size and value count stay within the configured caps.

The resolver must include useful content for this decision: the actual question context, candidate route/tool details, confirmed semantics, the rubric when a score needs one, and the relevant evidence excerpts or records. It must return the full state value, never only a `stateRef`, digest, or `claimId`. Errors should use `JevStateResolutionError` with a fixed code such as `NOT_FOUND`, `SCOPE_MISMATCH`, `VERSION_MISMATCH`, `INCOMPLETE`, `TOO_LARGE`, or `UNAVAILABLE`. Do not put state text or credentials in error messages.

The adapter exports `jevActualStateDigest(state)`. Host code uses this same canonical JSON plus UTF-8 SHA-256 algorithm when creating the immutable state ref: object keys are recursively sorted, arrays keep their order, and non-JSON values are rejected. The adapter requires `stateRef.digest` to equal this digest, so the ref pins the bytes sent to the provider. Evidence records that same ref and digest. The adapter has no decision cache; any host cache must key by the state digest and still perform current authorization and immutable-state validation before returning a hit.

```ts
const jev = new JevDecisionAdapter({
  baseUrl: 'https://api.typesafe.ai',
  secretRef: 'configured-server-side-secret-reference',
  models: { 'jev-decision': { vendorModel: 'jev-latest' } },
  stateResolver: authorizedStateResolver,
  // Existing secret, budget, ledger and evidence dependencies are also injected here.
  secrets,
  budget,
  ledgerId,
  evidence,
  fallbackPolicy: 'clarify',
})
```

If no resolver is configured, the call fails with `CAPABILITY_NOT_CONFIGURED` before reserving budget or contacting JEV. Scope, digest, completeness, and size failures also stop before any provider request. The adapter never expands the authorization envelope to satisfy a model request.

## Platform-to-System-One mapping

| Platform question | System One request | Result mapping |
| --- | --- | --- |
| Choice | `instructions` is the prompt; `criteria` maps each local `optionId` to its label. | The adapter validates the selected id, every probability, the probability sum, and confidence. It attaches the local `definitionVersion` and `optionSetHash` itself. |
| Score | Each candidate option expands into one System One Score question. Its structured instructions carry the platform prompt, candidate id/label, and declared numeric scale. Ordered numeric criteria contain 2–10 levels over the declared scale; the full rubric meaning must be present in actual state. The platform rubric ref stays local. | The adapter checks `legend`, each level probability, the sum, and that the returned score matches the probability-weighted level. It linearly maps the expected level back to the platform scale and keeps one `DecisionScore` per candidate with that answer's confidence. These are candidate scores, not a Choice probability distribution. |
| Noul | `instructions` is the yes/no prompt. Criteria are omitted because the platform question has no separate true/false descriptions. | The System One `noul` value is stored as the platform Noul `probability` (P(yes)); `confidence` remains absent. `minConfidence` never treats P(yes) as confidence. |

System One answer-map keys are internal to the request and are checked against the exact question plan. The provider does not need to return the platform definition version, option-set hash, question type metadata, or a state reference. The returned `model` is stored as provider model-version evidence; the configured `vendorModel` remains the request alias. Both `input_tokens` and `output_tokens` are required and charged to that attempt's shared run ledger.

## Retries, cancellation, and verification boundary

401 maps to `UNAUTHENTICATED`; 422 maps to `INVALID_ARGUMENT`. 429 and 529 map to bounded `RATE_LIMITED` retries and preserve `Retry-After`; because a response does not include token usage, these attempts settle as `usage_unknown` instead of releasing the reservation. A malformed or incomplete success response without both usage fields is also an explicit schema failure with `usage_unknown`. Each actual attempt reserves and settles once on the same ledger. Cancellation and deadline signals reach state resolution and HTTP fetch; no late result is returned after cancellation.

Unit tests use a local HTTP server that accepts only `POST /v1/systemone` and parses the actual JSON request. It checks actual state content, question maps, response validation, provider model and token usage, HTTP classification, retry/budget behavior, aborts, resolver authorization failures, and digest/size bounds. No paid TypeSafe API request or real customer state was used; external model quality and a production authorization backend remain for the deployment's external acceptance.

## Validation

- `pnpm exec vitest run tests/unit/model-jev-adapter.spec.ts tests/unit/model-jev-budget.spec.ts tests/unit/model-jev-layering.spec.ts` — 3 files, 60 tests passed.
- `pnpm exec tsc -p tsconfig.json --noEmit` — passed.
- Focused ESLint on the changed model-jev source and test files — passed.

The real TypeSafe service, paid model quality, and host production registry/authorization resolver were not exercised in this local test run.
