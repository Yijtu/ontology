import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { ProjectDocumentService } from '@ontology/app-api'
import type {
  ProjectDocumentIndexStatus,
  ProjectDocumentSearchResult,
} from '@ontology/contracts'
import { projectCollectionRef } from '@ontology/contracts'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function readyStatus(projectId: string): ProjectDocumentIndexStatus {
  return {
    projectId,
    collectionRef: projectCollectionRef(projectId),
    state: 'ready',
    visibilityEpoch: '1',
    membershipRevision: '1',
    indexEpoch: '1',
    generation: '1',
    indexRef: { id: projectCollectionRef(projectId), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    documentCount: 1,
    sourceDocumentCount: 1,
    completeness: 'complete',
    retryable: false,
  }
}

function emptyResult(projectId: string): ProjectDocumentSearchResult {
  return {
    projectId,
    collectionRef: projectCollectionRef(projectId),
    query: 'battery',
    fragments: [],
    state: 'ready',
    matchedTotal: 0,
    coverage: {
      returned: 0,
      knownTotal: 0,
      truncated: false,
      completeness: 'complete',
      maxFragments: 10,
      maxBytesPerFragment: 4096,
    },
    indexEpoch: '1',
    visibilityEpoch: '1',
    generation: '1',
    scoreKind: 'none',
    historical: false,
  }
}

function stubService(projectId: string) {
  return {
    importDocument: vi.fn(async () => readyStatus(projectId)),
    reviseDocument: vi.fn(async () => readyStatus(projectId)),
    buildIndex: vi.fn(async () => readyStatus(projectId)),
    getStatus: vi.fn(async () => readyStatus(projectId)),
    search: vi.fn(async () => emptyResult(projectId)),
  } satisfies ProjectDocumentService
}

function serverWith(service: ProjectDocumentService) {
  return createApiServer({
    authenticate: () => ({
      principal: {
        tenantId: TENANT,
        subjectId: 'route-test',
        roles: ['platform-admin'],
        scopes: [],
        authEpoch: 1,
      },
      spaceId: SPACE,
    }),
    projectDocuments: { service },
  })
}

describe('project document routes', () => {
  it('registers the corpus import, index build and status routes on the default host', async () => {
    const projectId = randomUUID()
    const service = stubService(projectId)
    const app = serverWith(service)
    try {
      const status = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/document-index`,
      })
      expect(status.statusCode).toBe(200)
      expect(service.getStatus).toHaveBeenCalledTimes(1)

      const build = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/document-index`,
      })
      expect(build.statusCode).toBe(202)
      expect(service.buildIndex).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })

  it('returns search results with coverage through the search route', async () => {
    const projectId = randomUUID()
    const service = stubService(projectId)
    const app = serverWith(service)
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/document-search`,
        payload: { query: 'battery warranty', limit: 5 },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { data: { result: ProjectDocumentSearchResult } }
      expect(body.data.result.coverage.maxFragments).toBe(10)
      expect(service.search).toHaveBeenCalledWith(
        expect.objectContaining({ projectId, query: 'battery warranty', limit: 5 }),
        expect.anything(),
      )
    } finally {
      await app.close()
    }
  })

  it('requires an operator role and an Idempotency-Key to import a membership', async () => {
    const projectId = randomUUID()
    const service = stubService(projectId)
    const app = serverWith(service)
    try {
      const missingBody = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/document-memberships`,
        headers: { 'idempotency-key': 'route-test-key-123' },
        payload: {},
      })
      expect(missingBody.statusCode).toBe(400)

      const rejected = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/document-memberships`,
        payload: { documentRef: { id: 'x' } },
      })
      expect(rejected.statusCode).toBe(400)
      expect(service.importDocument).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
