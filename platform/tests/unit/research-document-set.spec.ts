import { describe, expect, it } from 'vitest'
import {
  InMemoryResearchDocumentSetStore,
  ResearchDocumentSetService,
} from '@ontology/application'
import type { ResearchArchiveParsePort } from '@ontology/contracts'
import type {
  ArchivedPageDiscovery,
  DiscoveryOnlyPage,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX: ToolContext = createTestToolContext(TENANT_A, SPACE_A)

const WORKSPACE = '99999999-9999-4999-8999-999999999999'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const RUN_B = '44444444-4444-4444-8444-444444444444'

const DIGEST = (char: string): string => `sha256:${char.repeat(64)}`

function ref(id: string, digest: string): ResourceRef {
  return { id, version: '1.0.0', digest, kind: 'artifact' }
}

const SNAPSHOT: ResourceRef = ref('aaa11111-1111-4111-8111-111111111111', DIGEST('a'))
const MANIFEST: ResourceRef = ref('bbb22222-2222-4222-8222-222222222222', DIGEST('b'))
const PARSE_MAP: ResourceRef = ref('ccc33333-3333-4333-8333-333333333333', DIGEST('c'))

function archivedPage(): ArchivedPageDiscovery {
  return {
    discovery: 'archived',
    url: 'https://docs.example.com/heat-pump-tariff',
    title: 'Heat pump tariff guide',
    snippet: 'Residential heat-pump tariffs are published by each supplier.',
    fetchedAt: '2026-10-16T00:00:00Z',
    contentDigest: DIGEST('a'),
    contentTrust: 'untrusted_data',
    parserVersion: '1.0.0',
    snapshotRef: SNAPSHOT,
    snapshotManifestRef: MANIFEST,
    contentForm: 'html',
  }
}

const LINK_ONLY: DiscoveryOnlyPage = {
  discovery: 'discovery_only',
  url: 'https://docs.example.com/behind-a-paywall',
  title: 'Members only',
  snippet: 'A teaser that cannot be cited.',
  fetchedAt: '2026-10-16T00:00:00Z',
  contentDigest: DIGEST('d'),
  contentTrust: 'untrusted_data',
  unavailableReason: 'http_error',
}

/** Parses an archived original into a readable binding without a real parser (a test double). */
const scriptedParser: ResearchArchiveParsePort = {
  async parseArchivedPage(input) {
    return {
      documentRef: input.documentRef,
      parseId: 'dddd4444-4444-4444-8444-444444444444',
      parserVersion: '1.0.0',
      parseRef: PARSE_MAP,
      normalizedRef: ref('eeee5555-5555-4555-8555-555555555555', DIGEST('e')),
    }
  },
}

function service(): { readonly service: ResearchDocumentSetService; readonly store: InMemoryResearchDocumentSetStore } {
  const store = new InMemoryResearchDocumentSetStore()
  const instance = new ResearchDocumentSetService({ members: store, parser: scriptedParser, now: () => '2026-10-16T01:00:00Z' })
  return { service: instance, store }
}

describe('research staging stages archived pages and never a link', () => {
  it('stages an archived page as research_staged material, not a corpus entry', async () => {
    const { service: svc } = service()
    const receipt = await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [archivedPage()] }, CTX)

    expect(receipt.staged).toHaveLength(1)
    const member = receipt.staged[0]
    expect(member?.kind).toBe('research_archive')
    expect(member?.staged).toBe(true)
    expect(member?.inGroundingCorpus).toBe(false)
    expect(member?.sourceUrl).toBe('https://docs.example.com/heat-pump-tariff')
    expect(member?.provenanceRef?.digest).toBe(DIGEST('b'))
  })

  it('records a link-only discovery as skipped with its exact reason instead of staging it', async () => {
    const { service: svc } = service()
    const receipt = await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [LINK_ONLY] }, CTX)

    expect(receipt.staged).toHaveLength(0)
    expect(receipt.skipped).toEqual([{ url: LINK_ONLY.url, reason: 'http_error' }])
  })

  it('is idempotent: staging the same archived page twice yields one member', async () => {
    const { service: svc } = service()
    await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [archivedPage()] }, CTX)
    await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [archivedPage()] }, CTX)

    const page = await svc.listMembers({ workspaceId: WORKSPACE, runId: RUN_A, limit: 50 }, CTX)
    expect(page.members).toHaveLength(1)
  })
})

describe('one evidence set composes research archives and authorized documents (design §4)', () => {
  it('lets a research archive and an uploaded document share the same run', async () => {
    const { service: svc } = service()
    await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [archivedPage()] }, CTX)
    const authorized = await svc.stageAuthorizedDocument(
      {
        workspaceId: WORKSPACE,
        runId: RUN_A,
        documentRef: ref('ffff6666-6666-4666-8666-666666666666', DIGEST('f')),
        parseId: 'aaaa7777-7777-4777-8777-777777777777',
        parserVersion: '1.0.0',
        parseRef: PARSE_MAP,
        contentDigest: DIGEST('f'),
      },
      CTX,
    )
    expect(authorized.kind).toBe('authorized_document')

    const set = await svc.readSet({ workspaceId: WORKSPACE, runId: RUN_A, limit: 50 }, CTX)
    expect(set.members.map((member) => member.kind).sort()).toEqual(['authorized_document', 'research_archive'])

    // The composed members project to bounded targeted-read selections the agent can continue on.
    const selections = svc.toTargetedSelections(set.members)
    expect(selections).toHaveLength(2)
    expect(selections.every((selection) => selection.parseId !== undefined)).toBe(true)
  })
})

describe('a staged member is bound to its run and scope', () => {
  it('does not leak a member to another run', async () => {
    const { service: svc } = service()
    await svc.stageArchivedDiscoveries({ workspaceId: WORKSPACE, runId: RUN_A, pages: [archivedPage()] }, CTX)
    const other = await svc.listMembers({ workspaceId: WORKSPACE, runId: RUN_B, limit: 50 }, CTX)
    expect(other.members).toHaveLength(0)
  })

  it('refuses a cross-tenant read', async () => {
    const { store } = service()
    const otherTenant = createTestToolContext('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    await expect(store.listMembers(SCOPE_A, { workspaceId: WORKSPACE, runId: RUN_A, limit: 50 }, otherTenant)).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    })
  })
})
