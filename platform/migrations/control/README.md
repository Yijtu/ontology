# Control migrations (`agent_platform`)

Forward-only, versioned SQL migrations for the control PostgreSQL schema
(SPEC D8). They initialise and evolve the platform's own database; they contain
no historical-prototype import, no compatibility structures and never target a
customer production database.

## Applying them

Migrations are applied by an explicit step, never by service startup:

```text
CONTROL_DATABASE_URL=postgres://<owner>@<host>:5432/<db> \
  pnpm --filter @ontology/adapter-control-postgres migrate:control
```

`runControlMigrations` (exported from `@ontology/adapter-control-postgres`)
holds a PostgreSQL advisory lock, records every applied version plus a SHA-256
checksum in `agent_platform.control_schema_migrations`, skips already-applied
versions and fails if an applied migration's contents changed.

## v0.3 A migrations (058–077)

The v0.3 A release ([`../../docs/v03-a-release-2026-09-30.md`](../../docs/v03-a-release-2026-09-30.md)) appended these files;
none of `001..057` were edited:

```text
058_industry_workspace_project_revisions.sql
059_structured_ingestion.sql
060_structured_extraction_candidates.sql
061_asset_definition_candidates.sql
062_instance_review.sql
063_definition_edit_adjudications.sql
064_asset_rule_action_candidates.sql
065_synthetic_validation.sql
066_published_pack_assets.sql
067_project_readiness.sql
068_project_mapping_records.sql
069_project_document_index.sql
070_task_execution_bindings.sql
071_core_plan_receipts.sql
073_task_validation_policies.sql
075_compute_execution.sql
076_table_artifacts.sql
077_table_hard_verification.sql
```

Unused / reserved numbers in the `058–080` range: `072`/`074` (reserved for
parallel nodes), `078`/`079`/`080` (not yet allocated). `057` is held by the
parallel planning-receipts WIP and is not in this branch.

## Adding a migration

1. Add `NNN_snake_case.sql` with the next free numeric version.
2. Put `tenant_id`/`space_id` in every primary key and foreign key.
3. `ENABLE ROW LEVEL SECURITY` and add a `scope_isolation` policy for new
   tenant-owned tables, matching the shape used in `002_row_level_security.sql`.
4. Never edit or delete an already-applied file; add a new version instead.

Because `003_application_role.sql` sets schema default privileges, new tables
created by the same migration role are granted to `ontology_app` automatically.
