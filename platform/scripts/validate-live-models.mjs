#!/usr/bin/env node
/**
 * Operator-run live validation of the real company generation endpoint and the real JEV
 * endpoint (LOCAL-051). NOT part of CI and never run automatically: CI keeps the
 * deterministic doubles and needs no secrets.
 *
 * Usage (documentation only; the path is operator-supplied, never repository config):
 *
 *   cd platform
 *   pnpm exec tsx scripts/validate-live-models.mjs \
 *     --env-file="$ONTOLOGY_SECRETS_FILE" \
 *     --out=tests/e2e/artifacts/live-model-validation.json
 *
 * The script records only variable NAMES and presence; secret values are never written
 * to the report or to stdout. A blocked external condition is an honest result.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '..', 'tests', 'e2e', 'artifacts', 'live-model-validation.json')

function parseArgs(argv) {
  const args = { envFile: undefined, out: DEFAULT_OUT, modelRole: 'vendor-first', jevVendorModel: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    const readValue = () => {
      const eq = arg.indexOf('=')
      if (eq >= 0) return arg.slice(eq + 1)
      const next = argv[index + 1]
      index += 1
      return next
    }
    if (arg === '--env-file' || arg.startsWith('--env-file=')) args.envFile = readValue()
    else if (arg === '--out' || arg.startsWith('--out=')) args.out = readValue()
    else if (arg === '--model-role' || arg.startsWith('--model-role=')) args.modelRole = readValue()
    else if (arg === '--jev-vendor-model' || arg.startsWith('--jev-vendor-model=')) args.jevVendorModel = readValue()
  }
  return args
}

/** Minimal dotenv reader. Values are never printed; only names are surfaced later. */
function readEnvFile(path) {
  const text = readFileSync(path, 'utf8')
  const entries = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line.slice(0, eq).trim()
    let value = line.slice(eq + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    entries[name] = value
  }
  return entries
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const secretsFileArg = args.envFile ?? process.env.ONTOLOGY_SECRETS_FILE
  const secretsFile = secretsFileArg === undefined ? '' : isAbsolute(secretsFileArg) ? secretsFileArg : resolve(process.cwd(), secretsFileArg)

  let fileEnv = {}
  if (secretsFile.length > 0) {
    try {
      fileEnv = readEnvFile(secretsFile)
      process.stdout.write(`Loaded environment file: ${secretsFile}\n`)
    } catch (error) {
      process.stdout.write(`Could not read the environment file (${error instanceof Error ? error.message : String(error)}); continuing with the process environment.\n`)
    }
  } else {
    process.stdout.write('No --env-file or ONTOLOGY_SECRETS_FILE supplied; using the process environment only.\n')
  }

  const env = { ...process.env, ...fileEnv }
  const moduleUrl = new URL('../tests/evaluation/live/live-model-validation.ts', import.meta.url).href
  const { runLiveValidation } = await import(moduleUrl)
  const { formatCall } = await import(new URL('../tests/evaluation/live/live-report.ts', import.meta.url).href)

  const report = await runLiveValidation({
    env,
    secretsFile,
    modelMapRole: args.modelRole,
    ...(args.jevVendorModel === undefined ? {} : { jevVendorModel: args.jevVendorModel }),
  })

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write('\n=== live model validation ===\n')
  process.stdout.write('environment presence (names only):\n')
  for (const entry of report.envPresence) {
    process.stdout.write(`  ${entry.name}: ${entry.present ? (entry.empty ? 'present but EMPTY' : 'present') : 'absent'}\n`)
  }
  process.stdout.write('\nwire-level endpoint probes (raw, not through the adapter):\n')
  for (const call of report.endpointProbes) process.stdout.write(`  ${formatCall(call)}\n`)
  process.stdout.write('\ncompany generation (adapter-level):\n')
  for (const call of report.company) process.stdout.write(`  ${formatCall(call)}\n`)
  process.stdout.write('JEV decision:\n')
  process.stdout.write(`  ${formatCall(report.jev)}\n`)
  process.stdout.write(
    `\nlatency (n=${report.latency.samples}): p50=${report.latency.p50Ms.toFixed(0)}ms p95=${report.latency.p95Ms.toFixed(0)}ms max=${report.latency.maxMs.toFixed(0)}ms\n`,
  )
  process.stdout.write(
    `summary: validated=${report.summary.validated} blocked=${report.summary.blocked} error=${report.summary.error}\n`,
  )
  process.stdout.write(`report: ${args.out}\n`)
}

main().catch((error) => {
  process.stderr.write(`live validation failed to run: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
