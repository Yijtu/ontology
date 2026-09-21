import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { objectKeyForDigest, sha256Digest } from './digest'
import { BlobStoreError } from './errors'

/** Tenant/space scope of a staged upload; the published object itself is global. */
export interface BlobScope {
  readonly tenantId: string
  readonly spaceId: string
}

export interface StagedObject {
  readonly contentDigest: string
  readonly byteSize: number
}

/**
 * Content-addressed immutable object storage.
 *
 * Writes go through three separate, individually atomic steps — stage, verify,
 * publish — so a crash can leave a stray staged file or object but never a
 * half-published authorization reference. `publish` is content-addressed and
 * idempotent, so a retry after any failure is safe.
 */
export interface ImmutableObjectStore {
  stage(scope: BlobScope, content: Uint8Array): Promise<StagedObject>
  readStaged(scope: BlobScope, contentDigest: string): Promise<Uint8Array>
  discardStaged(scope: BlobScope, contentDigest: string): Promise<void>
  publish(contentDigest: string, content: Uint8Array): Promise<void>
  read(contentDigest: string): Promise<Uint8Array>
  remove(contentDigest: string): Promise<void>
}

const RENAME_RETRY_LIMIT = 8
const RENAME_RETRY_BASE_DELAY_MS = 5

function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function storedDigest(path: string): Promise<string | undefined> {
  try {
    return sha256Digest(await readFile(path))
  } catch {
    return undefined
  }
}

/**
 * Replace `targetPath` with the staged file.
 *
 * The object is content-addressed, so concurrent writers of the same digest race
 * onto one target path. On Windows `rename` fails with EPERM/EACCES while the
 * destination is held by another writer (POSIX rename simply overwrites), so a
 * transient failure is retried, and a destination that already holds the expected
 * digest is accepted as success — the write is idempotent by construction.
 */
async function replaceAtomically(
  temporaryPath: string,
  targetPath: string,
  contentDigest: string,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < RENAME_RETRY_LIMIT; attempt += 1) {
    try {
      await rename(temporaryPath, targetPath)
      return
    } catch (error) {
      lastError = error
      if (!isTransientRenameError(error)) throw error
      if ((await storedDigest(targetPath)) === contentDigest) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        return
      }
      await delay(RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt)
    }
  }
  throw lastError
}

async function writeAtomic(
  targetPath: string,
  content: Uint8Array,
  contentDigest: string,
): Promise<void> {
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`
  await writeFile(temporaryPath, content)
  try {
    await replaceAtomically(temporaryPath, targetPath, contentDigest)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export class FileSystemObjectStore implements ImmutableObjectStore {
  readonly #rootDir: string

  constructor(rootDir: string) {
    this.#rootDir = rootDir
  }

  async init(): Promise<void> {
    await mkdir(join(this.#rootDir, 'objects'), { recursive: true })
    await mkdir(join(this.#rootDir, 'staging'), { recursive: true })
  }

  #stagingDir(scope: BlobScope): string {
    return join(this.#rootDir, 'staging', scope.tenantId, scope.spaceId)
  }

  #objectPath(contentDigest: string): string {
    return join(this.#rootDir, 'objects', objectKeyForDigest(contentDigest))
  }

  async stage(scope: BlobScope, content: Uint8Array): Promise<StagedObject> {
    const contentDigest = sha256Digest(content)
    const directory = this.#stagingDir(scope)
    await mkdir(directory, { recursive: true })
    await writeAtomic(join(directory, objectKeyForDigest(contentDigest)), content, contentDigest)
    return { contentDigest, byteSize: content.byteLength }
  }

  async readStaged(scope: BlobScope, contentDigest: string): Promise<Uint8Array> {
    const path = join(this.#stagingDir(scope), objectKeyForDigest(contentDigest))
    try {
      return await readFile(path)
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobStoreError(
          'BLOB_CONTENT_NOT_STAGED',
          `no staged content matches ${contentDigest} in this scope`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async discardStaged(scope: BlobScope, contentDigest: string): Promise<void> {
    await rm(join(this.#stagingDir(scope), objectKeyForDigest(contentDigest)), { force: true })
  }

  async publish(contentDigest: string, content: Uint8Array): Promise<void> {
    await mkdir(join(this.#rootDir, 'objects'), { recursive: true })
    await writeAtomic(this.#objectPath(contentDigest), content, contentDigest)
  }

  async read(contentDigest: string): Promise<Uint8Array> {
    let content: Uint8Array
    try {
      content = await readFile(this.#objectPath(contentDigest))
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobStoreError(
          'BLOB_OBJECT_MISSING',
          `the object for ${contentDigest} is missing from storage`,
          { cause: error },
        )
      }
      throw error
    }
    const actual = sha256Digest(content)
    if (actual !== contentDigest) {
      throw new BlobStoreError(
        'BLOB_INTEGRITY_MISMATCH',
        `stored object digest ${actual} does not match the referenced digest ${contentDigest}`,
      )
    }
    return content
  }

  async remove(contentDigest: string): Promise<void> {
    await rm(this.#objectPath(contentDigest), { force: true })
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
