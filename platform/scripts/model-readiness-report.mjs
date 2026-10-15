#!/usr/bin/env node
/**
 * Operator entry point for the fixed modelling / parameter-extraction evaluation (V03-046).
 *
 * It runs the fixed set in controlled/loopback mode against the real services with a fixed
 * generation port and writes the model-readiness report. With no authorized real endpoint
 * the report records the controlled mechanism check and marks real-model quality
 * `not_verified`; it never claims extraction quality from the controlled run.
 *
 * Usage (documentation only):
 *
 *   cd platform
 *   pnpm exec tsx scripts/model-readiness-report.mjs \
 *     --out=tests/e2e/artifacts/model-readiness.json
 *
 * The report contains no secret: only model/api versions, the reference-set digest and
 * review classifications.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '..', 'tests', 'e2e', 'artifacts', 'model-readiness.json')

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT }
  for (const arg of argv) {
    if (arg === undefined) continue
    if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length)
    else if (arg === '--out') throw new Error('use --out=<path>')
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const out = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)
  const moduleUrl = new URL('../tests/evaluation/modelling/modelling-eval.ts', import.meta.url).href
  const { runModellingParameterEvaluation } = await import(moduleUrl)
  const result = await runModellingParameterEvaluation()

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result.report, null, 2)}\n`, 'utf8')

  const report = result.report
  process.stdout.write('\n=== modelling / parameter-extraction evaluation ===\n')
  process.stdout.write(`reference set digest: ${report.evalSetDigest}\n`)
  process.stdout.write(
    `controlled: proves=${report.controlled.proves} cases=${String(report.controlled.summary.cases)} ` +
      `passed=${String(report.controlled.summary.passed)} failed=${String(report.controlled.summary.failed)}\n`,
  )
  process.stdout.write(
    `real-model quality: ${report.realModel.status} (api=${report.realModel.apiVersion} model=${report.realModel.modelVersion})\n`,
  )
  process.stdout.write(`reason: ${report.realModel.reason}\n`)
  process.stdout.write(`report: ${out}\n`)
}

main().catch((error) => {
  process.stderr.write(
    `model readiness report failed to run: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
