# Core server model capabilities

This document describes an independently tested composition module. The default Core host has
not yet connected it to its planner, online runtime or verifier; setting these flags alone does
not enable a complete natural-language product flow. Host/launcher flag propagation and real
provider compatibility remain separate acceptance checks.

`apps/api/src/composition/core-model-capabilities.ts` builds the existing company `GenerationPort` and optional TypeSafe `DecisionPort`. It accepts a server-only environment map and host-owned secret, budget, evidence and actual-state ports. The factory parses enabled configuration once; `forExecution({ ledgerId, signal })` binds each adapter to the already-opened run/job ledger and that execution's cancellation signal. It never opens or settles a second ledger itself.

Company generation and JEV decision are independently disabled by default:

| Capability | Enable flag | Required server configuration |
| --- | --- | --- |
| Company generation | `CORE_ENABLE_MODELS=true` | `CORE_COMPANY_MODEL_BASE_URL`, `CORE_COMPANY_MODEL_SECRET_REF`, `CORE_COMPANY_MODEL_PLATFORM_ID`, `CORE_COMPANY_MODEL_VENDOR_MODEL`, `CORE_COMPANY_MODEL_PROTOCOL` |
| JEV decision | `CORE_ENABLE_JEV=true` | `CORE_JEV_BASE_URL`, `CORE_JEV_SECRET_REF`, `CORE_JEV_PLATFORM_MODEL_ID`, `CORE_JEV_VENDOR_MODEL` |

Both flags accept only `true` or `false`; absent flags mean disabled. When a capability is enabled, missing or invalid configuration raises `CoreModelConfigurationError` without resolving a credential or sending a request. Company protocol is explicit: `private` or `openai-compatible`; optional `CORE_COMPANY_MODEL_ENDPOINT` defaults to the existing adapter path `/v1/generate`. JEV uses official System One protocol at `/v1/systemone` by default; optional `CORE_JEV_ENDPOINT` overrides the path. JEV fallback defaults to `reject`; `CORE_JEV_FALLBACK_POLICY` may select `deterministic`, `generative_classification`, `clarify` or `reject`. The generative-classification policy requires a separately injected fallback port. Optional `CORE_JEV_MIN_CONFIDENCE` must be in `[0,1]` and does not treat Noul probability-of-yes as confidence.

Platform and provider model IDs are separate. `CORE_COMPANY_MODEL_PLATFORM_ID` and `CORE_JEV_PLATFORM_MODEL_ID` must match the `modelRef.modelId` selected by the host; their respective `*_VENDOR_MODEL` settings are sent to the provider. The provider's returned model version and measured usage remain adapter evidence/accounting data.

Each `*_SECRET_REF` is an opaque resolver reference, for example `env:CORE_COMPANY_MODEL_API_KEY` or `env:CORE_JEV_API_KEY`. The corresponding values belong only in the API process environment; the factory never reads or returns them. Do not prefix credentials with `VITE_` or pass them to the web build. The browser receives only deployment metadata.

The deployment metadata's model status should be enabled when either model flag is true; JEV-only configuration must not require company credentials. The Core launcher must retain only the enabled capability's server settings and key environment variable, while stripping all model secrets from Vite's environment.

When extraction uses `accountingOwner: 'adapter'`, `generationForRun` receives the actual job ledger, abort signal, job id and input. It calls the factory for that execution; the company adapter alone reserves and settles each provider attempt, including retries and `usage_unknown`. The pipeline keeps its legacy `accountingOwner: 'pipeline'` default for generic ports and existing test doubles. Native structured records do not need a model. If no adapter port is configured, native extraction still works and prose fails before reservation with `CAPABILITY_NOT_CONFIGURED` at the job stage.

The canonical job error catalogue currently has no separate cancellation code. The extraction
stage uses `DEADLINE_EXCEEDED` with a neutral stopped-before-completion message for cancellation;
it does not retry or publish an empty success after an aborted stream. Online run cancellation
still belongs to the Controller's explicit run state, independent of this job-stage mapping.

The current canonical `ErrorCode` set has no cancellation member. Extraction preserves its internal `CANCELLED` classification, but the job error projection uses the existing `DEADLINE_EXCEEDED` code rather than extending the shared catalogue. Cancellation still propagates; a possibly billed provider attempt remains `usage_unknown`.

JEV enablement requires the host to inject `DecisionEvidenceRecorder` and an authorized `JevActualStateResolver`. That resolver supplies the bounded actual state approved for the request's state reference; a hash or opaque reference is never sent as a substitute. The factory has no generic fallback resolver and does not widen authorization.

## Validation

Focused unit tests use controlled loopback HTTP servers and in-memory ledgers to exercise the company wire mapping, JEV `/v1/systemone` body with resolved actual state, independent enable flags, per-attempt reservation/settlement, retries, `usage_unknown`, cancellation, native extraction without a model and explicit no-model job failure. These tests do not contact an external model provider. Provider quality, credentials, company deployment compatibility and real network latency have not been tested.

Run the focused tests from `platform/`:

```text
pnpm exec vitest run tests/unit/core-model-capabilities.spec.ts tests/unit/extraction-adapter-accounting.spec.ts tests/unit/extraction-pipeline.spec.ts
```
