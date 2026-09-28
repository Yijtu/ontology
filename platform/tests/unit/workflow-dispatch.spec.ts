import { describe, expect, it } from 'vitest'
import { PostgresWorkflowDispatchStore } from '@ontology/adapter-control-postgres'
import { toolContext } from './component-registry-fixtures'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const STORE = new PostgresWorkflowDispatchStore({
  withIdentityScope: async () => {
    throw new Error('a validated invalid request must not reach persistence')
  },
})
const CONTEXT = toolContext(undefined, undefined, undefined, undefined, RUN_ID)

describe('PostgresWorkflowDispatchStore request boundary', () => {
  it('rejects an invalid lease bound before querying persistence', async () => {
    await expect(STORE.claimNext({ ownerId: RUN_ID, leaseDurationMs: 999 }, CONTEXT))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects invalid logical-action and failure identifiers before querying persistence', async () => {
    await expect(STORE.enqueue({ runId: RUN_ID, logicalActionId: 'contains whitespace' }, CONTEXT))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(STORE.fail({
      dispatchId: RUN_ID,
      ownerId: RUN_ID,
      attempt: '1',
      expectedRevision: '2',
      failureCode: 'Provider error includes details',
    }, CONTEXT)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
