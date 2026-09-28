# Core local startup

This setup uses an isolated Docker Compose project, a loopback PostgreSQL port, and a non-superuser application connection. It does not use the existing ports 3000, 5173, or 54329. PostgreSQL migrations run only from the explicit preparation command; starting the API never migrates a database.

## First start on Windows PowerShell

Run these commands from `platform/`. Replace the example server password with a local-only value and reuse that same value whenever you start this Compose project in a new shell. Do not use a password from chat or another environment.

```powershell
$env:CORE_PG_PORT = '54330'
$env:CORE_POSTGRES_PASSWORD = 'replace-with-a-local-only-password'
docker compose --project-name ontology-core-local --file deploy/core/compose.yaml up --detach

$escapedPassword = [uri]::EscapeDataString($env:CORE_POSTGRES_PASSWORD)
$env:CORE_CONTROL_DATABASE_URL = "postgresql://postgres:$escapedPassword@127.0.0.1:$($env:CORE_PG_PORT)/ontology_core"
pnpm exec tsx scripts/prepare-core-db.ts
pnpm exec node scripts/dev-core.mjs
```

Compose binds PostgreSQL to `127.0.0.1:54330` by default, checks it with `pg_isready`, and stores data in the Compose-named `core_pg_data` volume. The project name keeps its container and volume separate from other local databases.

`prepare-core-db.ts` applies the existing control migrations, configures the migrated `ontology_app` role for login while keeping it non-superuser and `NOBYPASSRLS`, and creates only the demo tenant and space. It verifies an application-role connection, then writes `.env.core.local`. That ignored file contains the app DSN, app password, local ports, demo scope, and `CORE_ENABLE_MODELS=false`; the launcher defaults the independent JEV flag to false when it is absent. It does not contain the admin DSN or the PostgreSQL server password. Re-running preparation uses the app password already in the local file unless `CORE_APP_PASSWORD` is explicitly supplied.

The launcher validates the loopback app DSN and distinct ports, probes the configured API and Web ports before spawning children, starts the API on `CORE_API_PORT` and Vite on `CORE_WEB_PORT`, and waits for `/healthz` and the web root with bounded timeouts. Occupied ports fail before startup so another local service cannot be mistaken for this Core instance. It passes `VITE_CORE_API_PORT` to Vite so the Core Vite config can proxy the browser's relative `/api` calls. Database credentials are sent only to the API process; Vite receives no database DSN, model credentials, or caller-supplied `VITE_` variables. If `apps/api/src/core-main.ts` has not been implemented, the launcher exits with a clear missing-entry error and starts no service. It never reports readiness without both services responding.

## Restart, migrations, and stop

For a normal restart in a new PowerShell window, set the same server password and port, bring up the existing project, and run the launcher. The named volume is reused:

```powershell
$env:CORE_PG_PORT = '54330'
$env:CORE_POSTGRES_PASSWORD = 'the-same-local-only-password'
docker compose --project-name ontology-core-local --file deploy/core/compose.yaml up --detach
pnpm exec node scripts/dev-core.mjs
```

After changing migrations, set `CORE_CONTROL_DATABASE_URL` again using the same encoded-password command from the first-start section, then rerun `pnpm exec tsx scripts/prepare-core-db.ts`. The migration runner applies only unapplied migrations and rejects changed checksums for already-applied versions.

Press **Ctrl+C** in the launcher window to stop the API and Vite children. To stop PostgreSQL while preserving its data, run:

```powershell
docker compose --project-name ontology-core-local --file deploy/core/compose.yaml stop
```

`docker compose down` without `--volumes` also retains the named data volume. Do not use `down --volumes`, `docker volume prune`, or broad Docker cleanup for routine shutdown.

## Models and the workbench

External model calls are disabled by default. `CORE_ENABLE_MODELS=true` enables the Company generation adapter; `CORE_ENABLE_JEV=true` independently enables JEV, so JEV-only operation does not require Company configuration. The launcher forwards each enabled adapter's `CORE_*` settings and only the environment variable named by its opaque `*_SECRET_REF`; it removes disabled-adapter settings and all unreferenced secrets. Vite receives neither adapter settings nor secrets. The launcher does not configure a profile or call a model by itself. Use only provider settings documented by the Core model capability module and deployment profile.

The profile selection, source import, and query flow is described in [SPEC §8, Local deployment and usable UI](../../tasks/spec-main-core-product-2026-09-28.md#8-本地部署与可用-ui) and the [product README](../../README.md). The current browser obtains scenario metadata from `/api/v1/core/deployment`. Startup readiness does not imply every Workbench or query route is configured; the independent review records the remaining product checks.

## Validation and current limits

The preparation config unit tests cover app-role DSN creation, default scope/ports, exclusion of admin credentials from `.env.core.local`, and rejection of remote, wrong-database, and legacy-port targets. Node launcher tests cover both-models-off, generation-only, JEV-only, API-only referenced secrets, `VITE_` filtering, rejection of generic `DATABASE_URL`, missing-entry failure, and occupied-port detection. `dev-core.mjs` is also checked by Node syntax validation and focused ESLint. The compose file is validated with `docker compose config`; this does not create or restart a container.

The initial prepare check used a temporary PostgreSQL instance with its own named volume: 25 migrations applied on the first run and none on the second; `ontology_app` was non-superuser, `NOBYPASSRLS`, and saw zero unscoped tenant rows. A later actual subprocess launcher check applied all 28 current migrations in a new temporary database. It found and fixed Vite's incorrect working-directory root and missing proxy; API/Web readiness and the same-origin deployment metadata request then succeeded. Browser import, identity confirmation, approval and fact publication also succeeded. The temporary database, volume, local environment and artifacts were removed afterward. Complete Workbench/query navigation, new-profile activation and independent process restart remain separate acceptance checks. See the [independent review](main-core-independent-review-2026-09-28.md).
