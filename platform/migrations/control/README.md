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

## Adding a migration

1. Add `NNN_snake_case.sql` with the next free numeric version.
2. Put `tenant_id`/`space_id` in every primary key and foreign key.
3. `ENABLE ROW LEVEL SECURITY` and add a `scope_isolation` policy for new
   tenant-owned tables, matching the shape used in `002_row_level_security.sql`.
4. Never edit or delete an already-applied file; add a new version instead.

Because `003_application_role.sql` sets schema default privileges, new tables
created by the same migration role are granted to `ontology_app` automatically.
