import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunApi } from '@ontology/app-api'
import { CapabilityNotConfiguredError } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { buildWorkflowHarness, ownerContext, ScriptedRuntime } from './workflow-fixtures'

const owner = ownerContext()
const auth: AuthenticatedRequest = { principal: owner.principal, spaceId: owner.allowedResources.spaceId }

describe('normal run API dispatch requirement', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses HTTP acceptance before RunService writes when durable enqueue is absent', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [] }) })
    const createRun = vi.spyOn(harness.service, 'createRun')
    const app = createRunApi({ service: harness.service, authenticate: () => auth })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/runs',
        headers: { 'idempotency-key': 'missing-dispatch' },
        payload: {
          profileRef: { id: 'transport-inspection', version: '1.0.0' },
          question: 'Show the current inspection status.',
          context: { timeZone: 'UTC', siteRef: 'site-1' },
          preferences: { route: 'template', allowWeb: false },
        },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json<{ error: { code: string } }>().error.code).toBe('CAPABILITY_NOT_CONFIGURED')
      expect(createRun).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('refuses unsupported questions before creating a durable run', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [] }) })
    const createRun = vi.spyOn(harness.service, 'createRun')
    const enqueue = vi.fn(async () => undefined)
    const app = createRunApi({
      service: harness.service,
      authenticate: () => auth,
      dispatch: { enqueue, cancelRun: async () => undefined },
      validateSubmission: async () => {
        throw new CapabilityNotConfiguredError('this profile does not register the requested task')
      },
    })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/runs',
        headers: { 'idempotency-key': 'unsupported-task' },
        payload: {
          profileRef: { id: 'transport-inspection', version: '1.0.0' },
          question: 'What should I do next?',
          context: { timeZone: 'UTC', siteRef: 'site-1' },
          preferences: { route: 'template', allowWeb: false },
        },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json<{ error: { code: string } }>().error.code).toBe('CAPABILITY_NOT_CONFIGURED')
      expect(createRun).not.toHaveBeenCalled()
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
