# Core multi-attribute facts checkpoint

Core's normal `POST /api/v1/runs` path now accepts a registered facts request containing one to
three comma-separated attribute IDs, for example:

```text
facts:operating_hours,maintenance_exempt,asset_id
```

The host resolves the submitted profile version to its immutable run snapshot, selects the
mounted industry from that snapshot's `industryRef`, and builds the facts plan from the run's
actual profile ref, snapshot hash, resolved mappings, definition ref, and trusted tenant/space.
It does not use the deployment's base profile as a substitute. A profile ID can therefore point
to another mounted industry package when that is what its resolved spec declares.

Each requested attribute becomes its own read-only `ontology_lookup(intent: facts)` step. The
steps use the selected industry's namespace and exact definition version, then the existing
published-facts provider, typed draft writer, and hard verifier produce one answer whose claims
and assertions cite their own evidence records. The three-attribute HTTP integration covers this
path with model flags off and confirms that all three properties and three distinct evidence refs
survive a host restart on the same run.

The deployment response keeps its stable scenario slot while projecting the active profile's
actual industry data: label, namespace, definition, profile mapping refs, available tasks, and raw
source refs. `sourceScenarioId` tells the import panel which mounted scenario owns those raw
sources, so a profile slot configured for another industry does not submit a source under the
wrong scenario ID.

Unsupported input fails during submission validation, before a run or dispatch row is created.
The HTTP error envelope carries a specific code: `INVALID_QUESTION`, `UNKNOWN_PROPERTY`,
`DUPLICATE_PROPERTY`, `TOO_MANY_PROPERTIES`, or `AMBIGUOUS_PROPERTY`. The facts plan is bounded
to three unique properties; unrestricted natural-language planning and business rule conclusions
remain unavailable.

## Checkpoint compatibility

The plan reference now hashes the run's actual profile/snapshot/mapping/definition pins and the
complete property list. A not-yet-completed template checkpoint created by an older single-
attribute Core resolver may contain a different plan reference. On resume the current host
rebuilds the plan from the run's immutable inputs and fails closed if the full reference differs;
it does not discard or rewrite the checkpoint reference to replay different work. Previously
published answers and their evidence remain readable. Durable plan-receipt migration is a later
step.

## Validation

Focused UI and PostgreSQL checks from `platform/`:

```text
pnpm exec vitest run tests/ui/query.spec.ts tests/ui/core-import-panel.spec.ts tests/unit/core-deployment-client.spec.ts --maxWorkers=1
pnpm exec vitest run tests/integration/core-local-host-postgres.spec.ts --maxWorkers=1
```

The PostgreSQL case changes a transport profile ID to an industrial profile spec, checks that
deployment metadata and source import target follow the industrial pins, then reads three
industrial attributes through a normal run and verifies the same answer and evidence after
restarting the API composition. Tests use a named-volume isolated PostgreSQL fixture and tear it
down. They do not contact an external model service.
