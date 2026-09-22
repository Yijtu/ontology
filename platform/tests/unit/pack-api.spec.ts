import { describe, expect, it } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  INDUSTRY_REF,
  PACK_ADMIN_A,
  PACK_EDITOR_A,
  PACK_RUNNER_A,
  RUN_A,
  RUNTIME_V1,
  RUNTIME_V2,
  SCOPE_A,
  buildPackHarness,
  componentRecord,
  sampleProfileSpec,
  seedComponents,
} from './pack-fixtures'

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  return {
    principal: { tenantId: SCOPE_A.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: SCOPE_A.spaceId,
  }
}

function headers(roles = 'profile-editor'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-test-subject': 'pack-editor-a',
    'x-test-roles': roles,
  }
}

describe('industry pack API (LOCAL-041)', () => {
  it('reports maturity-gated usability and never calls a preparation pack validated', async () => {
    const harness = await buildPackHarness()
    const app = createApiServer({
      authenticate: testAuthenticator,
      packs: {
        catalogue: harness.catalogue,
        packExports: harness.exporter,
        packUpgrades: harness.upgrader,
      },
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/industry-packs', headers: headers() })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ data: { packs: readonly { namespace: string; maturityLabel: string; usable: boolean }[] } }>()
    const byNamespace = new Map(body.data.packs.map((pack) => [pack.namespace, pack]))
    expect(byNamespace.get('home-energy')?.maturityLabel).toBe('experimental')
    expect(byNamespace.get('home-energy')?.usable).toBe(false)
    expect(byNamespace.get('automotive')?.maturityLabel).toBe('defined')
    expect(byNamespace.get('health-services')?.maturityLabel).toBe('experimental')
    expect(body.data.packs.every((pack) => pack.maturityLabel !== 'validated')).toBe(true)
    expect(body.data.packs.every((pack) => pack.usable === false)).toBe(true)

    await app.close()
  })

  it('exports a portable bundle and blocks an upgrade to a retired version', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: { id: 'home-energy-demo', version: '1.0.0' }, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    await seedComponents(
      harness.registryStore,
      [
        componentRecord({
          kind: 'runtime',
          id: 'runtime-template',
          version: '1.1.0',
          digest: RUNTIME_V2.digest,
          provides: [{ name: 'agent_runtime', version: '1.1.0' }],
        }),
      ],
      SCOPE_A,
      PACK_ADMIN_A,
    )
    const app = createApiServer({
      authenticate: testAuthenticator,
      packs: {
        catalogue: harness.catalogue,
        packExports: harness.exporter,
        packUpgrades: harness.upgrader,
      },
    })

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/industry-packs/${INDUSTRY_REF.id}/export?version=${INDUSTRY_REF.version}`,
      headers: headers(),
    })
    expect(exported.statusCode).toBe(200)
    const exportBody = exported.json<{ data: { namespace: string; mappingTemplates: readonly unknown[] } }>()
    expect(exportBody.data.namespace).toBe('home-energy')
    expect(exportBody.data.mappingTemplates.length).toBeGreaterThan(0)

    const upgrade = await app.inject({
      method: 'POST',
      url: `/api/v1/industry-packs/${INDUSTRY_REF.id}/upgrade`,
      headers: headers(),
      payload: {
        sourceProfileRef: { id: 'home-energy-demo', version: '1.0.0' },
        targetProfileRef: { id: 'home-energy-demo', version: '2.0.0' },
        slot: { kind: 'runtime' },
        targetRef: RUNTIME_V2,
      },
    })
    expect(upgrade.statusCode).toBe(200)
    expect(upgrade.json<{ data: { status: string } }>().data.status).toBe('applicable')

    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, to: 'deprecated' },
      PACK_ADMIN_A,
    )
    await harness.registry.acquireActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )

    const retire = await app.inject({
      method: 'POST',
      url: `/api/v1/industry-packs/${INDUSTRY_REF.id}/retire`,
      headers: headers('platform-admin'),
      payload: { component: { kind: 'runtime', id: 'runtime-template', version: '1.0.0' } },
    })
    expect(retire.statusCode).toBe(409)
    const retireBody = retire.json<{ error: { code: string; reasons?: readonly string[] } }>()
    expect(retireBody.error.code).toBe('RETIREMENT_BLOCKED')
    expect(retireBody.error.reasons?.some((reason) => reason.includes('active run'))).toBe(true)

    await app.close()
  })
})
