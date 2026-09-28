import { describe, expect, it, vi } from 'vitest'
import { createCoreApi } from '@ontology/app-api'
import { loadCoreExamples } from '@ontology/app-api'

const scopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

function examples() {
  return loadCoreExamples({ targetScopeRef: scopeRef })
}

describe('core-main API bootstrap', () => {
  it('reports readiness only while the control database responds', async () => {
    const queryUnscoped = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 })
    const app = createCoreApi({
      database: { queryUnscoped },
      scopeRef,
      examples: examples(),
    })
    try {
      const ready = await app.inject({ method: 'GET', url: '/healthz' })
      expect(ready.statusCode).toBe(200)
      expect(ready.json()).toEqual({ status: 'ready', controlStore: 'connected' })
      expect(queryUnscoped).toHaveBeenCalledWith('SELECT 1')

      queryUnscoped.mockRejectedValueOnce(new Error('database unavailable'))
      const unavailable = await app.inject({ method: 'GET', url: '/healthz' })
      expect(unavailable.statusCode).toBe(503)
      expect(unavailable.json()).toEqual({ status: 'not_ready', controlStore: 'unavailable' })
    } finally {
      await app.close()
    }
  })

  it('serves validated synthetic deployment metadata without exposing local paths', async () => {
    const app = createCoreApi({
      database: { queryUnscoped: async () => ({ rows: [], rowCount: 0 }) },
      scopeRef,
      examples: examples(),
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/core/deployment',
        remoteAddress: '127.0.0.1',
      })
      expect(response.statusCode).toBe(200)
      const body = response.json<{
        data: {
          classification: string
          scenarios: { scenarioId: string; namespace: string; availableTasks: string[]; rawSourceRefs: unknown[] }[]
          models: { generation: boolean; decision: boolean }
          operatorEnabled: boolean
        }
      }>()
      expect(body.data.classification).toBe('public_synthetic_demo_not_an_industry_standard')
      expect(body.data.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
        'transport-facility-inspection',
        'industrial-asset-maintenance',
      ])
      expect(body.data.scenarios.every((scenario) => scenario.availableTasks.length === 0)).toBe(true)
      expect(body.data.scenarios[0]?.rawSourceRefs).toHaveLength(3)
      expect(JSON.stringify(body)).not.toContain('D:/work')
      expect(JSON.stringify(body)).not.toContain('/records/')
      expect(body.data.models).toEqual({ generation: false, decision: false })
      expect(body.data.operatorEnabled).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('does not authenticate a non-loopback request as the fixed local principal', async () => {
    const app = createCoreApi({
      database: { queryUnscoped: async () => ({ rows: [], rowCount: 0 }) },
      scopeRef,
      examples: examples(),
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/core/deployment',
        remoteAddress: '192.0.2.17',
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
