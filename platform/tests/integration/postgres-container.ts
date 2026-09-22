import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Client } from 'pg'

const execFileAsync = promisify(execFile)

/**
 * Harness label applied to the containers and data volumes this helper creates.
 *
 * PITFALL (observed 2026-09, leaked 4013 volumes / ~177 GB): the postgres image
 * creates an anonymous volume for `/var/lib/postgresql/data`. `docker run --rm`
 * does NOT reclaim that volume when the container is torn down with a bare
 * `docker rm -f <name>` — the bare form leaves the anonymous volume orphaned, so
 * every integration run leaked one ~44 MB volume until `docker system df` showed
 * 177 GB of reclaimable volumes and the host disk filled up.
 *
 * The harness therefore mounts an explicitly *named*, labelled volume so cleanup
 * is targeted and verifiable, and always removes both container and volume. If
 * volumes are ever leaked again, reclaim only ours with:
 *   docker volume ls -f label=ontology.test-harness=postgres -q | xargs -r docker volume rm -f
 */
const HARNESS_LABEL = 'ontology.test-harness=postgres'

async function removeContainerAndVolume(containerName: string, volumeName: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', '-v', containerName]).catch(() => undefined)
  await execFileAsync('docker', ['volume', 'rm', '-f', volumeName]).catch(() => undefined)
}

/**
 * Remove harness data volumes left behind by an earlier crash or kill. Volumes
 * still attached to a running container are refused by the daemon and skipped,
 * so this never disturbs a concurrently running suite.
 */
export async function sweepOrphanedPostgresVolumes(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'volume',
      'ls',
      '-f',
      `label=${HARNESS_LABEL}`,
      '-q',
    ])
    const names = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    let removed = 0
    for (const name of names) {
      const ok = await execFileAsync('docker', ['volume', 'rm', '-f', name]).then(
        () => true,
        () => false,
      )
      if (ok) removed += 1
    }
    return removed
  } catch {
    return 0
  }
}

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
  const volumeName = `ontology-pg-data-${suffix}`

  await execFileAsync('docker', ['volume', 'create', '--label', HARNESS_LABEL, volumeName]).catch(
    () => undefined,
  )

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
      '-v',
      `${volumeName}:/var/lib/postgresql/data`,
      '-p',
      `${host}::5432`,
      image,
    ])
  } catch (error) {
    await removeContainerAndVolume(containerName, volumeName)
    throw new Error('could not start the throwaway PostgreSQL container (is Docker running?)', {
      cause: error,
    })
  }

  let port: number
  try {
    port = await publishedLoopbackPort(containerName)
  } catch (error) {
    await removeContainerAndVolume(containerName, volumeName)
    throw error
  }

  const adminUrl = `postgresql://postgres:${encodeURIComponent(password)}@${host}:${port}/postgres`
  try {
    await waitUntilReady(adminUrl, 90_000)
  } catch (error) {
    await removeContainerAndVolume(containerName, volumeName)
    throw error
  }

  return {
    containerName,
    host,
    port,
    adminUrl,
    image,
    stop: async () => {
      await removeContainerAndVolume(containerName, volumeName)
    },
  }
}
