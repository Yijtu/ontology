import { spawn, execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const PLATFORM_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCAL_ENV_PATH = resolve(PLATFORM_ROOT, '.env.core.local')
const API_ENTRY = resolve(PLATFORM_ROOT, 'apps', 'api', 'src', 'core-main.ts')
const TSX_CLI = resolve(PLATFORM_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VITE_CLI = resolve(PLATFORM_ROOT, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js')
const API_READY_TIMEOUT_MS = 45_000
const WEB_READY_TIMEOUT_MS = 30_000
const READINESS_POLL_MS = 400
const EXTERNAL_MODEL_ENV = [
  'ONTOLOGY_COMPANY_MODEL_BASE_URL',
  'ONTOLOGY_COMPANY_MODEL_ENDPOINT',
  'ONTOLOGY_COMPANY_MODEL_API_KEY',
  'ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS',
  'ONTOLOGY_JEV_BASE_URL',
  'ONTOLOGY_JEV_ENDPOINT',
  'ONTOLOGY_JEV_API_KEY',
]
const PRIVATE_ENV = [
  'CORE_CONTROL_DATABASE_URL',
  'CORE_POSTGRES_PASSWORD',
  'CORE_APP_PASSWORD',
  'CONTROL_DATABASE_URL',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'PGPASSWORD',
]

export function parseEnvFileText(contents) {
  const values = {}
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (assignment === null) throw new Error('Malformed .env.core.local assignment')
    const key = assignment[1]
    const raw = assignment[2] ?? ''
    if (key === undefined) throw new Error('Malformed .env.core.local key')
    Object.defineProperty(values, key, {
      value: unquote(raw),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return values
}

export function resolveCoreDevEnvironment(
  fileEnvironment,
  explicitEnvironment,
) {
  const env = { ...fileEnvironment, ...explicitEnvironment }
  const databaseUrl = required(env, 'CORE_DATABASE_URL')
  let parsedUrl
  try {
    parsedUrl = new URL(databaseUrl)
  } catch {
    throw new Error('CORE_DATABASE_URL must be a valid local PostgreSQL connection URL')
  }
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('CORE_DATABASE_URL must use the postgres or postgresql scheme')
  }
  if (parsedUrl.username !== 'ontology_app') {
    throw new Error('CORE_DATABASE_URL must use the non-superuser ontology_app role')
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname.toLowerCase())) {
    throw new Error('CORE_DATABASE_URL must target a loopback core database')
  }
  if (decodeURIComponent(parsedUrl.pathname.replace(/^\//u, '')) !== 'ontology_core') {
    throw new Error('CORE_DATABASE_URL must target the ontology_core database')
  }

  const apiPort = readPort(env['CORE_API_PORT'], 3001, 'CORE_API_PORT')
  const webPort = readPort(env['CORE_WEB_PORT'], 5174, 'CORE_WEB_PORT')
  const pgPort = readPort(env['CORE_PG_PORT'], 54330, 'CORE_PG_PORT')
  const legacyPorts = new Set([3_000, 5_173, 54_329])
  if ([apiPort, webPort, pgPort].some((port) => legacyPorts.has(port))) {
    throw new Error('Core ports must stay isolated from the existing 3000/5173/54329 services')
  }
  if (new Set([apiPort, webPort, pgPort]).size !== 3) {
    throw new Error('CORE_API_PORT, CORE_WEB_PORT, and CORE_PG_PORT must be distinct')
  }
  if (env['VITE_CORE_API_PORT'] !== undefined &&
      readPort(env['VITE_CORE_API_PORT'], apiPort, 'VITE_CORE_API_PORT') !== apiPort) {
    throw new Error('VITE_CORE_API_PORT must match CORE_API_PORT')
  }
  if (Number(parsedUrl.port || '5432') !== pgPort) {
    throw new Error('CORE_DATABASE_URL port must match CORE_PG_PORT')
  }

  const tenantId = readUuid(env['CORE_TENANT_ID'], '11111111-1111-4111-8111-111111111111', 'CORE_TENANT_ID')
  const spaceId = readUuid(env['CORE_SPACE_ID'], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'CORE_SPACE_ID')
  const modelsEnabled = env['CORE_ENABLE_MODELS'] === 'true'

  const apiEnvironment = { ...env }
  for (const name of PRIVATE_ENV) delete apiEnvironment[name]
  for (const name of Object.keys(apiEnvironment)) {
    if (name.startsWith('VITE_')) delete apiEnvironment[name]
  }
  if (!modelsEnabled) {
    for (const name of EXTERNAL_MODEL_ENV) delete apiEnvironment[name]
    for (const name of Object.keys(apiEnvironment)) {
      if (/(?:API_KEY|SECRET|TOKEN|PASSWORD)$/iu.test(name) && name !== 'CORE_DATABASE_URL') {
        delete apiEnvironment[name]
      }
    }
  }
  Object.assign(apiEnvironment, {
    CORE_DATABASE_URL: databaseUrl,
    CORE_API_PORT: String(apiPort),
    CORE_PG_PORT: String(pgPort),
    CORE_TENANT_ID: tenantId,
    CORE_SPACE_ID: spaceId,
    CORE_ENABLE_MODELS: modelsEnabled ? 'true' : 'false',
  })

  const webEnvironment = { ...apiEnvironment }
  for (const name of Object.keys(webEnvironment)) {
    if (name.startsWith('VITE_')) delete webEnvironment[name]
  }
  for (const name of PRIVATE_ENV) delete webEnvironment[name]
  for (const name of EXTERNAL_MODEL_ENV) delete webEnvironment[name]
  for (const name of Object.keys(webEnvironment)) {
    if (/(?:API_KEY|SECRET|TOKEN|PASSWORD)$/iu.test(name)) delete webEnvironment[name]
  }
  delete webEnvironment['CORE_DATABASE_URL']
  Object.assign(webEnvironment, {
    CORE_WEB_PORT: String(webPort),
    VITE_CORE_API_PORT: String(apiPort),
    VITE_API_BASE_URL: '',
  })

  return { apiPort, webPort, pgPort, tenantId, spaceId, apiEnvironment, webEnvironment }
}

export async function requireCoreApiEntry(entryPath = API_ENTRY) {
  try {
    await access(entryPath)
  } catch {
    throw new Error(`Core API entry is not implemented yet: ${entryPath}. No services were started.`)
  }
}

/** Do not mistake an unrelated service already bound to a configured port for Core readiness. */
export async function assertLoopbackPortAvailable(port, label = 'Core service') {
  const probe = createServer()
  try {
    await new Promise((resolvePromise, reject) => {
      probe.once('error', reject)
      probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolvePromise)
    })
  } catch {
    throw new Error(`${label} port ${String(port)} is already occupied; Core did not start any service`)
  } finally {
    if (probe.listening) {
      await new Promise((resolvePromise) => probe.close(() => resolvePromise()))
    }
  }
}

async function main() {
  await requireCoreApiEntry()
  let fileContents
  try {
    fileContents = await readFile(LOCAL_ENV_PATH, 'utf8')
  } catch {
    throw new Error('Missing .env.core.local; run the local database preparation command first.')
  }
  const fileEnvironment = parseEnvFileText(fileContents)
  const configuration = resolveCoreDevEnvironment(fileEnvironment, process.env)
  await assertLoopbackPortAvailable(configuration.apiPort, 'Core API')
  await assertLoopbackPortAvailable(configuration.webPort, 'Core Web')
  await access(TSX_CLI).catch(() => {
    throw new Error('Local TSX CLI is missing; run pnpm install in platform/.')
  })
  await access(VITE_CLI).catch(() => {
    throw new Error('Local Vite CLI is missing; run pnpm install in platform/.')
  })

  const children = []
  let exitCode = 0
  let shutdownPromise
  let resolveStopped
  const stopped = new Promise((resolvePromise) => { resolveStopped = resolvePromise })

  const stop = (code) => {
    if (shutdownPromise !== undefined) return shutdownPromise
    exitCode = code
    shutdownPromise = (async () => {
      for (const child of children) {
        child.__coreStopRequested = true
        child.kill('SIGINT')
      }
      await Promise.all(children.map(stopChild))
      resolveStopped()
    })()
    return shutdownPromise
  }

  const onInterrupt = () => { void stop(0) }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)

  try {
    const apiChild = startNodeChild(
      TSX_CLI,
      [API_ENTRY],
      configuration.apiEnvironment,
      'Core API',
    )
    children.push(apiChild)
    watchUnexpectedExit(apiChild, 'Core API', stop)
    await waitForReady(
      apiChild,
      `http://127.0.0.1:${String(configuration.apiPort)}/healthz`,
      API_READY_TIMEOUT_MS,
      'Core API',
    )

    const webChild = startNodeChild(
      VITE_CLI,
      ['--config', 'apps/web/vite.config.ts', '--host', '127.0.0.1', '--port', String(configuration.webPort), '--strictPort'],
      configuration.webEnvironment,
      'Core Web',
    )
    children.push(webChild)
    watchUnexpectedExit(webChild, 'Core Web', stop)
    await waitForReady(
      webChild,
      `http://127.0.0.1:${String(configuration.webPort)}/`,
      WEB_READY_TIMEOUT_MS,
      'Core Web',
    )

    process.stdout.write(
      `Core local services are ready. Web: http://127.0.0.1:${String(configuration.webPort)}  API: http://127.0.0.1:${String(configuration.apiPort)}\n` +
      `Scope: ${configuration.tenantId} / ${configuration.spaceId}. Press Ctrl+C to stop API and Web; PostgreSQL data is preserved.\n`,
    )
    await stopped
    process.exitCode = exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected startup error'
    process.stderr.write(`Core local startup failed: ${message}\n`)
    await stop(1)
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onInterrupt)
  }
}

function startNodeChild(script, args, env, label) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: PLATFORM_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: process.platform === 'win32',
  })
  child.on('error', () => {
    child.__coreSpawnError = true
    process.stderr.write(`${label} process could not be started.\n`)
  })
  return child
}

function watchUnexpectedExit(child, label, stop) {
  child.once('exit', (code, signal) => {
    if (!stoppingRequested(child)) {
      process.stderr.write(`${label} exited before Ctrl+C (code ${String(code)}, signal ${String(signal)}).\n`)
      void stop(code === 0 ? 1 : code ?? 1)
    }
  })
}

function stoppingRequested(child) {
  return child.__coreStopRequested === true
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  child.__coreStopRequested = true
  const exited = await waitForExit(child, 5_000)
  if (exited) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3_000 }).catch(() => undefined)
  } else {
    child.kill('SIGTERM')
    if (!(await waitForExit(child, 2_000))) child.kill('SIGKILL')
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const finish = (result) => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolvePromise(result)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function waitForReady(child, url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before its readiness check passed`)
    }
    if (child.__coreSpawnError === true) throw new Error(`${label} could not be spawned`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) return
    } catch {
      // Retry connection errors until the bounded readiness deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, READINESS_POLL_MS))
  }
  throw new Error(`${label} did not become ready within ${String(timeoutMs / 1_000)} seconds`)
}

function required(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function readPort(value, fallback, name) {
  if (value === undefined || value.length === 0) return fallback
  if (!/^[1-9]\d{0,4}$/u.test(value)) throw new Error(`${name} must be an integer between 1 and 65535`)
  const port = Number(value)
  if (port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`)
  return port
}

function readUuid(value, fallback, name) {
  const candidate = value ?? fallback
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(candidate)) {
    throw new Error(`${name} must be a UUID`)
  }
  return candidate.toLowerCase()
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error('Malformed quoted value in .env.core.local')
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'unexpected startup error'
    process.stderr.write(`Core local startup failed: ${message}\n`)
    process.exitCode = 1
  })
}
