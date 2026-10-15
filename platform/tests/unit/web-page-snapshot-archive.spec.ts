import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  resourceKindForPurpose,
  sha256Digest,
} from '@ontology/adapter-blob-local'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from '@ontology/adapter-blob-local'
import { HttpWebSearchProvider, WebPageSnapshotArchiver } from '@ontology/adapter-search-web'
import { createBlobArtifactWriter } from '@ontology/app-api'
import { assertWebPageSnapshotManifestShape } from '@ontology/contracts'
import type { ScopeRef, ToolContext, VersionRef, WebPageSnapshotManifest } from '@ontology/contracts'
import { gatewayContext } from './tool-gateway-fixtures'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { SAFE_PAGE, scenarioWith } from '../fixtures/web-search/fixtures'

const ctx: ToolContext = gatewayContext()
const scopeRef: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
const PROVIDER_REF: VersionRef = { id: 'web-search.http', version: '1.0.0', digest: sha256Digest(new TextEncoder().encode('ref')) }

/** In-memory registry so the archiver test can use the real content-addressed blob store. */
class InMemoryRegistry implements ArtifactRegistry {
  readonly #blobs = new Map<string, ArtifactBlobRecord>()
  readonly #references = new Map<string, ArtifactReferenceRecord>()

  async recordReference(input: RecordArtifactReferenceInput): Promise<RecordArtifactReferenceResult> {
    const blobKey = `${input.scope.tenantId}/${input.scope.spaceId}/${input.contentDigest}`
    let blob = this.#blobs.get(blobKey)
    let deduplicated = false
    if (blob === undefined) {
      blob = {
        tenantId: input.scope.tenantId,
        spaceId: input.scope.spaceId,
        contentDigest: input.contentDigest,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        objectKey: input.objectKey,
        lineageId: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      this.#blobs.set(blobKey, blob)
    } else {
      deduplicated = true
    }
    const reference: ArtifactReferenceRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      origin: input.origin ?? {},
      createdAt: new Date().toISOString(),
    }
    this.#references.set(`${input.scope.tenantId}/${input.scope.spaceId}/${input.blobRefId}`, reference)
    return {
      blobRef: { id: input.blobRefId, version: '1.0.0', digest: input.contentDigest, kind: resourceKindForPurpose(input.purpose) },
      lineageId: blob.lineageId,
      deduplicated,
      reference,
    }
  }

  async findReference(scope: ScopeRef, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    const reference = this.#references.get(`${scope.tenantId}/${scope.spaceId}/${blobRefId}`)
    if (reference === undefined) return undefined
    const blob = this.#blobs.get(`${scope.tenantId}/${scope.spaceId}/${reference.contentDigest}`)
    return blob === undefined ? undefined : { reference, blob }
  }

  async listOrigins(scope: ScopeRef, contentDigest: string): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#references.values()].filter(
      (reference) => reference.tenantId === scope.tenantId && reference.spaceId === scope.spaceId && reference.contentDigest === contentDigest,
    )
  }

  async close(): Promise<void> {}
}

const createdDirs: string[] = []
async function realBlobStore(): Promise<LocalImmutableBlobStore> {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-archive-'))
  createdDirs.push(dir)
  const objectStore = new FileSystemObjectStore(dir)
  await objectStore.init()
  return new LocalImmutableBlobStore({ objectStore, registry: new InMemoryRegistry() })
}

afterAll(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fetchReturning(status: number, body: string, headers: Record<string, string>): typeof fetch {
  return async () => new Response(body, { status, headers })
}

function archiverFor(fetchImpl: typeof fetch, overrides?: { readonly maxBytes?: number; readonly now?: () => string }): WebPageSnapshotArchiver {
  return new WebPageSnapshotArchiver({
    artifacts: { putBytes: async () => { throw new Error('unexpected write') } },
    fetchImpl,
    now: overrides?.now ?? (() => '2026-10-15T00:00:00Z'),
    ...(overrides?.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
  })
}

const PAGE = 'https://docs.example.com/heat-pump-tariff'
const ALLOWED = ['example.com']

function deadline(offsetMs = 5_000): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function request(overrides?: Partial<{ url: string; allowedDomains: readonly string[]; deadline: string; signal: AbortSignal }>) {
  return {
    url: PAGE,
    allowedDomains: ALLOWED,
    deadline: deadline(),
    signal: new AbortController().signal,
    providerRef: PROVIDER_REF,
    ...overrides,
  }
}

describe('snapshot archiver refuses everything it cannot verify', () => {
  it('refuses an out-of-allowlist host before any request leaves', async () => {
    let called = 0
    const archiver = archiverFor(async () => { called += 1; return new Response('x') })
    const outcome = await archiver.archive(request({ url: 'https://evil.example.net/x' }), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'domain_not_allowed' })
    expect(called).toBe(0)
  })

  it('refuses a non-https page address', async () => {
    const archiver = archiverFor(async () => new Response('x'))
    const outcome = await archiver.archive(request({ url: 'http://docs.example.com/x' }), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'domain_not_allowed' })
  })

  it('refuses a redirect instead of following it', async () => {
    const archiver = archiverFor(fetchReturning(302, '', { location: 'https://evil.example.net/' }))
    const outcome = await archiver.archive(request(), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'redirect_forbidden' })
  })

  it('refuses a body larger than the download cap', async () => {
    const archiver = archiverFor(fetchReturning(200, 'x'.repeat(64), { 'content-type': 'text/html' }), { maxBytes: 16 })
    const outcome = await archiver.archive(request(), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'download_exceeded' })
  })

  it('refuses an unsupported content form as a link only', async () => {
    const archiver = archiverFor(fetchReturning(200, '%PDF-1.7', { 'content-type': 'application/pdf' }))
    const outcome = await archiver.archive(request(), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'unsupported_content_type' })
  })

  it('reports an empty body and an http error distinctly', async () => {
    const empty = archiverFor(fetchReturning(200, '', { 'content-type': 'text/html' }))
    expect(await empty.archive(request(), ctx)).toMatchObject({ reason: 'empty_body' })
    const failed = archiverFor(fetchReturning(503, 'down', { 'content-type': 'text/html' }))
    expect(await failed.archive(request(), ctx)).toMatchObject({ reason: 'http_error' })
  })

  it('reports a page timeout as a link only', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const archiver = archiverFor(hang)
    const outcome = await archiver.archive(request({ deadline: new Date(Date.now() + 25).toISOString() }), ctx)
    expect(outcome).toMatchObject({ status: 'discovery_only', reason: 'fetch_timeout' })
  })

  it('propagates a run-level cancellation instead of masking it as a link', async () => {
    const controller = new AbortController()
    controller.abort()
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expect(archiverFor(hang).archive(request({ signal: controller.signal }), ctx)).rejects.toThrow()
  })

  it('propagates an archive storage failure instead of reporting a link-only page', async () => {
    const archiver = archiverFor(fetchReturning(200, '<p>content</p>', { 'content-type': 'text/html' }))
    await expect(archiver.archive(request(), ctx)).rejects.toThrow('unexpected write')
  })
})

describe('snapshot archiver records the actual bytes, not the search summary', () => {
  it('archives and reads back the exact bytes with a matching digest, and separately archives derived text', async () => {
    const blobStore = await realBlobStore()
    const artifacts = createBlobArtifactWriter(blobStore)
    const html = '<html><head><title>Tariff</title><script>evil()</script><style>p{}</style></head><body><h1>Heat pump tariff</h1><p>Standing charges apply.</p></body></html>'
    const archiver = new WebPageSnapshotArchiver({
      artifacts,
      fetchImpl: fetchReturning(200, html, { 'content-type': 'text/html; charset=utf-8' }),
      now: () => '2026-10-15T09:30:00Z',
    })

    const outcome = await archiver.archive(request(), ctx)
    if (outcome.status !== 'archived') throw new Error(`expected an archived snapshot, got ${outcome.reason}`)

    // The digest names the exact retrieved bytes, and read-back re-verifies them.
    expect(outcome.contentDigest).toBe(sha256Digest(new TextEncoder().encode(html)))
    const read = await blobStore.readAuthorized({ scopeRef, blobRef: outcome.snapshotRef }, ctx)
    expect(new TextDecoder().decode(read)).toBe(html)
    expect((await blobStore.getAuthorized({ scopeRef, blobRef: outcome.snapshotRef }, ctx)).integrityVerified).toBe(true)
    expect(outcome.fetchedAt).toBe('2026-10-15T09:30:00Z')

    // The manifest records provenance and limits and validates at the artifact boundary.
    const manifestBytes = await blobStore.readAuthorized({ scopeRef, blobRef: outcome.manifestRef }, ctx)
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown
    assertWebPageSnapshotManifestShape(manifest)
    const typed = manifest as WebPageSnapshotManifest
    expect(typed).toMatchObject({ schemaVersion: 'web-page-snapshot@1', url: PAGE, contentForm: 'html', providerRef: PROVIDER_REF })
    expect(typed.limits).toMatchObject({ redirectsAllowed: false })
    expect(typed.originalRef.id).toBe(outcome.snapshotRef.id)

    // The derived parse is a *separate* artifact from the retrieved bytes.
    if (outcome.parsedRef === undefined) throw new Error('expected a derived parse artifact')
    expect(outcome.parsedRef.digest).not.toBe(outcome.snapshotRef.digest)
    const parsedBytes = await blobStore.readAuthorized({ scopeRef, blobRef: outcome.parsedRef }, ctx)
    const parsedText = new TextDecoder().decode(parsedBytes)
    expect(parsedText).toContain('Heat pump tariff')
    expect(parsedText).toContain('Standing charges apply.')
    expect(parsedText).not.toContain('evil()')
    expect(parsedText).not.toContain('<')
  })

  it('does not attach a snapshot to a page it refused', async () => {
    const blobStore = await realBlobStore()
    const archiver = new WebPageSnapshotArchiver({
      artifacts: createBlobArtifactWriter(blobStore),
      fetchImpl: fetchReturning(200, 'binary', { 'content-type': 'application/octet-stream' }),
    })
    const outcome = await archiver.archive(request(), ctx)
    expect(outcome.status).toBe('discovery_only')
  })
})

describe('the provider marks link-only results and archives real pages', () => {
  let fixture: WebSearchFixture
  const pageHtml = '<html><body><h1>Heat pump tariff guide</h1><p>Published rates.</p></body></html>'

  it('marks every page link-only when no archiver is configured', async () => {
    fixture = await startWebSearchFixture()
    try {
      fixture.setScenario(scenarioWith([SAFE_PAGE]))
      const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
      const result = await provider.search(
        { query: 'tariff', allowedDomains: ['example.com'], limit: 5, deadline: deadline(), signal: new AbortController().signal },
        ctx,
      )
      expect(result.pages[0]?.snapshotRef).toBeUndefined()
      expect(result.pages[0]?.snapshotUnavailableReason).toBe('archive_not_configured')
    } finally {
      await fixture.stop()
    }
  })

  it('attaches a verifiable snapshot and describes the archived bytes when configured', async () => {
    fixture = await startWebSearchFixture()
    try {
      fixture.setScenario(scenarioWith([SAFE_PAGE]))
      const blobStore = await realBlobStore()
      const provider = new HttpWebSearchProvider({
        baseUrl: fixture.baseUrl,
        snapshotArchive: new WebPageSnapshotArchiver({
          artifacts: createBlobArtifactWriter(blobStore),
          fetchImpl: fetchReturning(200, pageHtml, { 'content-type': 'text/html' }),
          now: () => '2026-10-15T10:00:00Z',
        }),
      })
      const result = await provider.search(
        { query: 'tariff', allowedDomains: ['example.com'], limit: 5, deadline: deadline(), signal: new AbortController().signal },
        ctx,
      )
      const page = result.pages[0]
      if (page?.snapshotRef === undefined) throw new Error('expected an archived page')

      // The page digest is the archived bytes, not the provider's search summary.
      expect(page.contentDigest).toBe(sha256Digest(new TextEncoder().encode(pageHtml)))
      expect(page.contentDigest).not.toBe(sha256Digest(new TextEncoder().encode(SAFE_PAGE.content)))
      expect(page.snapshotManifestRef).toBeDefined()
      expect(page.snapshotUnavailableReason).toBeUndefined()

      const read = await blobStore.readAuthorized({ scopeRef, blobRef: page.snapshotRef }, ctx)
      expect(new TextDecoder().decode(read)).toBe(pageHtml)
    } finally {
      await fixture.stop()
    }
  })

  it('keeps an out-of-content-form page as a link only, never a fake snapshot', async () => {
    fixture = await startWebSearchFixture()
    try {
      fixture.setScenario(scenarioWith([SAFE_PAGE]))
      const blobStore = await realBlobStore()
      const provider = new HttpWebSearchProvider({
        baseUrl: fixture.baseUrl,
        snapshotArchive: new WebPageSnapshotArchiver({
          artifacts: createBlobArtifactWriter(blobStore),
          fetchImpl: fetchReturning(200, '%PDF', { 'content-type': 'application/pdf' }),
        }),
      })
      const result = await provider.search(
        { query: 'tariff', allowedDomains: ['example.com'], limit: 5, deadline: deadline(), signal: new AbortController().signal },
        ctx,
      )
      expect(result.pages[0]?.snapshotRef).toBeUndefined()
      expect(result.pages[0]?.snapshotUnavailableReason).toBe('unsupported_content_type')
    } finally {
      await fixture.stop()
    }
  })
})
