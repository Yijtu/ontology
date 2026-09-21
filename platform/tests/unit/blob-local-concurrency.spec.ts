import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, sha256Digest } from '@ontology/adapter-blob-local'
import type { BlobScope } from '@ontology/adapter-blob-local'

const SCOPE: BlobScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

const roots: string[] = []

async function createStore(): Promise<FileSystemObjectStore> {
  const root = await mkdtemp(join(tmpdir(), 'blob-local-concurrency-'))
  roots.push(root)
  const store = new FileSystemObjectStore(root)
  await store.init()
  return store
}

function toBytes(value: Uint8Array): number[] {
  return Array.from(value)
}

async function temporaryFilesUnder(root: string, subdirectory: string): Promise<string[]> {
  const entries = await readdir(join(root, subdirectory), { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.includes('.tmp-'))
    .map((entry) => entry.name)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('content-addressed writes under concurrency', () => {
  it('publishes the same content from many writers without a rename race', async () => {
    const store = await createStore()
    const content = new TextEncoder().encode('shared immutable artifact payload')
    const digest = sha256Digest(content)

    await Promise.all(
      Array.from({ length: 32 }, async () => {
        await store.publish(digest, content)
      }),
    )

    expect(toBytes(await store.read(digest))).toEqual(toBytes(content))
  })

  it('stages the same content from many writers in one scope without a rename race', async () => {
    const store = await createStore()
    const content = new TextEncoder().encode('shared staged document payload')
    const digest = sha256Digest(content)

    const staged = await Promise.all(
      Array.from({ length: 32 }, async () => store.stage(SCOPE, content)),
    )

    expect(new Set(staged.map((entry) => entry.contentDigest))).toEqual(new Set([digest]))
    expect(toBytes(await store.readStaged(SCOPE, digest))).toEqual(toBytes(content))
  })

  it('leaves no temporary files behind after concurrent publishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blob-local-concurrency-'))
    roots.push(root)
    const store = new FileSystemObjectStore(root)
    await store.init()

    const contents = Array.from({ length: 8 }, (_, index) =>
      new TextEncoder().encode(`payload-${index}`),
    )

    await Promise.all(
      contents.flatMap((content) =>
        Array.from({ length: 8 }, async () => store.publish(sha256Digest(content), content)),
      ),
    )

    expect(await temporaryFilesUnder(root, 'objects')).toEqual([])
  })

  it('still rejects a genuine missing object after the retry loop', async () => {
    const store = await createStore()
    const missing = `sha256:${'b'.repeat(64)}`

    await expect(store.read(missing)).rejects.toMatchObject({ code: 'BLOB_OBJECT_MISSING' })
  })
})
