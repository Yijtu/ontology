# Core model host and job lifecycle checkpoint

This checkpoint connects the existing Company generation adapter to Core's normal ingestion
host. It does not make the query box a general natural-language interface and does not claim
that JEV planning, rule derivation, Pi runtime, or loop execution is complete.

## Company generation through ingestion

Company generation remains disabled unless the API process is started with
`CORE_ENABLE_MODELS=true` and the required Company model settings from
[`core-model-capabilities-2026-09-28.md`](core-model-capabilities-2026-09-28.md). Credentials
are resolved by the API process. They are not returned through deployment metadata or passed to
Vite.

The normal import endpoint accepts bounded UTF-8 text for a registered scenario and source. The
document is archived and parsed through the regular ingestion pipeline. Native structured
records can be extracted without a model. Other prose requires the configured Company
`GenerationPort`; if it is disabled, Core returns `CAPABILITY_NOT_CONFIGURED` before creating a
job or model-budget reservation. The model can propose candidates, but an operator still reviews
and confirms identity before publication.

An isolated PostgreSQL integration test uses a controlled loopback OpenAI-compatible server. It
submits ordinary facility text, checks that the resulting candidate contains its source-backed
network and district values, reads the original text back through the candidate-source endpoint,
and verifies one settled adapter-owned reservation (39 reported tokens) and one `model_output`
evidence record under the same job ID. No external provider, credential, or paid endpoint is
used by this test.

## Worker context and cancellation

The background worker remints its scope context on each polling iteration and creates a job-bound
context for the claimed job. The integration test starts with a bootstrap context whose five-minute
deadline is already past, then moves a continuously advancing test clock to current wall time
before submitting the job. It also checks that the persisted `next_attempt_at` is due. The job
still completes its controlled Company request without waiting five minutes, demonstrating that
the job uses a fresh context rather than reusing the expired bootstrap context.

Job execution forwards shutdown cancellation to the stage handler. If a handler ignores the
signal and returns a publication afterward, the worker records a controlled failure and does not
publish or advance that late result. Provider calls that may have reached a remote service can
still have uncertain billing; adapter accounting retains that uncertainty rather than creating a
second pipeline reservation.

## Scope and verification

The local synthetic deployment labels ontology and data-query tool results as synthetic. This is
deployment metadata about the mounted example sources; it does not change source payloads or
represent customer-owned production data.

Focused validation for this checkpoint:

```text
pnpm exec vitest run tests/integration/core-model-host-postgres.spec.ts --maxWorkers=1
pnpm exec vitest run tests/integration/core-local-host-postgres.spec.ts --maxWorkers=1
pnpm exec vitest run tests/unit/job-service.spec.ts tests/unit/workflow-dispatch-worker.spec.ts tests/unit/workflow-controller.spec.ts --maxWorkers=1
pnpm exec vitest run tests/unit/core-main.spec.ts tests/unit/ontology-lookup.spec.ts --maxWorkers=1
pnpm exec vitest run tests/unit/core-model-evidence.spec.ts --maxWorkers=1
```

These tests use isolated test databases or controlled in-process dependencies. They do not verify
external model quality, unrestricted natural-language planning, business rule conclusions, or a
complete end-user workflow for every registered scenario.
