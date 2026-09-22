import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Client } from 'pg'

const execFileAsync = promisify(execFile)

export interface PostgresContainer {
  readonly containerName: string
  readonly host: string
  readonly port: number
  readonly adminUrl: string
  readonly image: string
  stop(): Promise<void>
}

/**
 * Read the loopback port Docker assigned to the container's 5432 binding. The daemon
 * owns the allocation (`-p 127.0.0.1::5432`), so it cannot collide with another suite
 * the way a manual probe-then-bind can.
 */
async function publishedLoopbackPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync('docker', ['port', containerName, '5432'])
  const match = /^127\.0\.0\.1:(\d+)\s*$/m.exec(stdout)
  const port = match?.[1] === undefined ? undefined : Number(match[1])
  if (port === undefined || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `could not read the published PostgreSQL port from "docker port": ${stdout.trim()}`,
    )
  }
  return port
}

async function waitUntilReady(connectionString: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 2000 })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      return
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
    }
    if (Date.now() > deadline) {
      throw new Error('PostgreSQL container did not become ready in time', { cause: lastError })
    }
    await delay(500)
  }
}

const CANDIDATE_IMAGES = ['postgres:17', 'postgres:16-alpine', 'postgres:16'] as const

async function imageIsPresent(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image])
    return true
  } catch {
    return false
  }
}

/**
 * Prefer an image already present on the daemon (so an air-gapped or
 * registry-restricted machine still runs the suite), otherwise the maintained
 * default that CI pulls.
 */
async function selectImage(): Promise<string> {
  const override = process.env.CONTROL_TEST_POSTGRES_IMAGE
  if (override !== undefined && override.length > 0) {
    return override
  }
  for (const image of CANDIDATE_IMAGES) {
    if (await imageIsPresent(image)) {
      return image
    }
  }
  return CANDIDATE_IMAGES[0]
}

/**
 * Start a throwaway PostgreSQL container on a unique name and an ephemeral loopback
 * port so parallel test runs never collide. Credentials are obvious throwaway values
 * and live only in this process.
 */
export async function startPostgresContainer(): Promise<PostgresContainer> {
  const image = await selectImage()
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  const containerName = `ontology-pg-${suffix}`
  const password = `throwaway_${randomBytes(6).toString('hex')}`
  const host = '127.0.0.1'

  try {
    await execFileAsync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      containerName,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '-p',
      `${host}::5432`,
      image,
    ])
  } catch (error) {
    throw new Error('could not start the throwaway PostgreSQL container (is Docker running?)', {
      cause: error,
    })
  }

  let port: number
  try {
    port = await publishedLoopbackPort(containerName)
  } catch (error) {
    await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
    throw error
  }

  const adminUrl = `postgresql://postgres:${encodeURIComponent(password)}@${host}:${port}/postgres`
  try {
    await waitUntilReady(adminUrl, 90_000)
  } catch (error) {
    await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
    throw error
  }

  return {
    containerName,
    host,
    port,
    adminUrl,
    image,
    stop: async () => {
      await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
    },
  }
}
