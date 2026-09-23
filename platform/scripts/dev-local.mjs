import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const env = { ...process.env }
try {
  const contents = await readFile('.env.local', 'utf8')
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line)
    if (match) env[match[1]] = match[2]
  }
} catch {
  // DATABASE_URL may be supplied by the caller instead.
}
if (!env.DATABASE_URL) throw new Error('Run `pnpm run prepare:local` first or set DATABASE_URL')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const launchOptions = { stdio: 'inherit', env, ...(process.platform === 'win32' ? { shell: true } : {}) }
const api = spawn(pnpmCommand, ['--filter', '@ontology/app-api', 'run', 'start:local'], launchOptions)
const webEnv = { ...env }
delete webEnv.DATABASE_URL
let web
const stop = () => { api.kill(); web?.kill() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
api.once('exit', (code) => { stop(); process.exit(code ?? 1) })
api.once('error', (error) => { process.stderr.write(`API process failed to start: ${error.message}\n`); process.exit(1) })

// The Vite page must not be available before the API has finished migrations/profile setup.
const readyUrl = `http://127.0.0.1:${env.PORT ?? '3000'}/api/v1/runs/scope?profileId=home-energy-demo-wide&version=1.0.0`
const deadline = Date.now() + 30_000
try {
  while (true) {
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) break
    } catch {
      // Startup may not have bound the loopback port yet.
    }
    if (Date.now() >= deadline) throw new Error('Local API did not become ready within 30 seconds. Check the API error above and PostgreSQL health.')
    await delay(300)
  }
} catch (error) {
  stop()
  throw error
}

web = spawn(pnpmCommand, ['--filter', '@ontology/app-web', 'run', 'dev', '--', '--host', '127.0.0.1'], { ...launchOptions, env: webEnv })
web.once('exit', (code) => { stop(); process.exit(code ?? 1) })
web.once('error', (error) => { process.stderr.write(`Web process failed to start: ${error.message}\n`); stop(); process.exit(1) })
