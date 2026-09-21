// Explicit control-database migration step (SPEC D8). Run it deliberately; it
// is never invoked by service startup.
//
//   CONTROL_DATABASE_URL=postgres://<owner>@<host>:5432/<db> \
//     pnpm --filter @ontology/adapter-control-postgres migrate:control
//
// `migrations.ts` has no relative imports, so Node's built-in TypeScript type
// stripping can load it directly without a build step.
import { fileURLToPath } from 'node:url'
import { runControlMigrations } from '../src/migrations.ts'

const connectionString = process.env.CONTROL_DATABASE_URL ?? process.env.DATABASE_URL
if (connectionString === undefined || connectionString.length === 0) {
  console.error(
    'CONTROL_DATABASE_URL (or DATABASE_URL) must be set to the control database owner connection string',
  )
  process.exit(1)
}

const migrationsDir =
  process.env.CONTROL_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../../migrations/control', import.meta.url))

try {
  const report = await runControlMigrations({ connectionString, migrationsDir })
  console.log(`control migrations: ${report.applied.length} applied, ${report.skipped.length} skipped`)
  for (const filename of report.applied) {
    console.log(`  applied ${filename}`)
  }
} catch (error) {
  console.error('control migration failed:', error)
  process.exit(1)
}
