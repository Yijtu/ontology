import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ImmutableArtifactWriter, ResourceRef, ToolContext } from '@ontology/contracts'
import { createCoreWebSearchProvider } from '@ontology/app-api'
import { toolContext } from './component-registry-fixtures'

const digest = (seed: string): `sha256:${string}` => `sha256:${seed.repeat(64).slice(0, 64)}`

function recordingArtifacts(): { readonly writer: ImmutableArtifactWriter; readonly writes: Uint8Array[] } {
  const writes: Uint8Array[] = []
  const writer: ImmutableArtifactWriter = {
    async putBytes(request) {
      writes.push(request.content)
      const ref: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: digest('a'), kind: 'artifact' }
      return { blobRef: ref, contentDigest: digest('a'), integrity: { algorithm: 'sha256', digest: digest('a'), verifiedAt: '2026-10-15T00:00:00Z' } }
    },
  }
  return { writer, writes }
}

/** A fetch that serves the search JSON for the search endpoint and HTML for a page URL. */
function fixtureFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({
        results: [{ url: 'https://docs.example.org/page', title: 'Standard', content: 'a citable standard', snippet: 'snippet' }],
        truncated: false,
        total: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('<html><body>Archived page body</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
}

const ctx = (): ToolContext => toolContext('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ['researcher', 'platform-admin'])

describe('normal-startup web search provider (N12)', () => {
  it('is explicitly absent when no search endpoint is configured', () => {
    const { writer } = recordingArtifacts()
    expect(createCoreWebSearchProvider({ env: {}, artifacts: writer })).toBeUndefined()
    expect(createCoreWebSearchProvider({ env: { CORE_WEB_SEARCH_BASE_URL: '   ' }, artifacts: writer })).toBeUndefined()
  })

  it('archives the actual page bytes behind each permitted result when configured', async () => {
    const { writer, writes } = recordingArtifacts()
    const provider = createCoreWebSearchProvider({
      env: { CORE_WEB_SEARCH_BASE_URL: 'https://search.example.com', CORE_WEB_SEARCH_ENDPOINT: '/search' },
      artifacts: writer,
      fetchImpl: fixtureFetch(),
      now: () => '2026-10-15T00:00:00Z',
    })
    expect(provider).toBeDefined()
    const result = await provider!.search({
      query: 'standard',
      allowedDomains: ['docs.example.org'],
      limit: 5,
      deadline: '2099-01-01T00:00:00Z',
      signal: new AbortController().signal,
    }, ctx())
    expect(result.pages).toHaveLength(1)
    const page = result.pages[0]
    expect(page?.url).toBe('https://docs.example.org/page')
    expect(page?.snapshotRef).toBeDefined()
    expect(page?.snapshotUnavailableReason).toBeUndefined()
    // The original bytes and the derived text are archived separately.
    expect(writes.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects an invalid numeric bound instead of silently defaulting', () => {
    const { writer } = recordingArtifacts()
    expect(() => createCoreWebSearchProvider({
      env: { CORE_WEB_SEARCH_BASE_URL: 'https://search.example.com', CORE_WEB_SEARCH_MAX_BYTES: 'not-a-number' },
      artifacts: writer,
    })).toThrow(/CORE_WEB_SEARCH_MAX_BYTES/u)
  })
})
