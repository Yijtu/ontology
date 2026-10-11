// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectEvolutionRecord } from '@ontology/contracts'
import { ProjectEvolutionPanel } from '../../apps/web/src/components/project/ProjectEvolutionPanel'
import type { ProjectSourceCatalogue } from '../../apps/web/src/api/project-workbench'

const api = vi.hoisted(() => ({
  readEvolutionTarget: vi.fn(),
  readProjectEvolution: vi.fn(),
  startProjectEvolution: vi.fn(),
  operateProjectEvolution: vi.fn(),
}))

vi.mock('../../apps/web/src/api/project-evolution', () => api)

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
const digest = `sha256:${'a'.repeat(64)}`
const projectId = '44444444-4444-4444-8444-444444444444'
const packRef = { id: 'test.pack', version: '1.1.0', digest }
const definitionRef = { id: 'test.definition', version: '1.1.0', digest }
const oldId = '55555555-5555-4555-8555-555555555555'
const newId = '66666666-6666-4666-8666-666666666666'
const originalRef = { id: '77777777-7777-4777-8777-777777777777', kind: 'document' as const, version: '1.0.0', digest }
const parseRef = { id: '88888888-8888-4888-8888-888888888888', kind: 'artifact' as const, version: '1.0.0', digest }
const mappingRef = {
  id: 'mapping-1', version: '1.0.0', digest, role: 'catalog' as const,
  sourceObjectRef: { sourceRef: { namespace: 'project-import' as const, sourceId: 'mapping-1' }, objectPath: 'asset' },
}

function evolution(id: string, state: ProjectEvolutionRecord['state']): ProjectEvolutionRecord {
  return {
    revision: '1', state, attempts: 0, recordOperations: 0, batches: 0, candidateIds: [],
    plan: {
      evolutionId: id, jobId: '99999999-9999-4999-8999-999999999999',
      previousRevisionRef: { projectId, revision: '2', digest },
      targetRevisionRef: { projectId, revision: '3', digest },
      strategy: { kind: 'new_version', reason: 'test' }, sources: [], impacts: [],
      maxAttempts: 1, maxBatches: 1, maxRecords: 10, maxRecordOperations: 10,
      requestDigest: digest, previousInputRef: { id: 'previous', kind: 'artifact', version: '1.0.0', digest },
    },
  } as ProjectEvolutionRecord
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ProjectEvolutionPanel read/write ordering', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(async () => {
    if (root !== undefined) await act(async () => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.resetAllMocks()
  })

  it('keeps a new plan when an older plan read finishes after the start write', async () => {
    const lateOldRead = deferred<ProjectEvolutionRecord>()
    api.readEvolutionTarget.mockResolvedValue({ packRef, definitionRef, objects: [{ objectId: 'asset', displayName: 'Asset', attributes: [{ attributeId: 'asset_code', displayName: 'Asset code', valueType: 'string', required: true }] }] })
    api.readProjectEvolution
      .mockResolvedValueOnce(evolution(oldId, 'cancelled'))
      .mockReturnValueOnce(lateOldRead.promise)
    api.startProjectEvolution.mockResolvedValue(evolution(newId, 'awaiting_review'))

    const project = { projectId, title: 'test', headRevision: '4', state: 'draft', createdBy: 'test', createdAt: '', updatedAt: '' }
    const revision = { ref: { projectId, revision: '2', digest }, mappingRefs: [mappingRef], industryPackRef: packRef, definitionRef, profileRef: { id: 'p', version: '1.0.0', snapshotHash: digest }, documentSetRef: { id: projectId, kind: 'artifact', version: '1.0.0', digest }, semanticPublicationRefs: [], sourceVisibilityEpoch: '1', changeReason: 'test' }
    const mapping = { mappingId: 'mapping-1', version: '1.0.0', ref: mappingRef, parseId: 'parse-1', originalRef, objectId: 'asset', entries: [{ fieldRef: 'asset_code', columnIndex: 0 }] }
    const catalogue = {
      project, revision,
      sources: [{ documentId: 'doc-1', originalRef, parseRef, parseId: 'parse-1', precision: 'exact', kind: 'csv', tables: [{ tableId: 'table-1', headerRow: 1, columns: [{ columnIndex: 0, header: 'asset_code', headerDigest: digest }], rows: [] }] }],
      objects: [],
    } as unknown as ProjectSourceCatalogue
    const client = { newRequestKey: () => 'request-key' } as never
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(createElement(ProjectEvolutionPanel, {
      client, project: project as never, revision: revision as never,
      packs: [{ kind: 'registered_pack', namespace: packRef.id, displayName: 'Test pack', packRef, maturity: 'stable', maturityLabel: 'validated', usable: true }],
      mappings: [mapping as never], catalogue, readOnly: false, initialEvolutionId: oldId,
      onChanged: () => undefined, onReview: () => undefined,
    })))
    expect(container.textContent).toContain('已取消')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(api.readProjectEvolution).toHaveBeenCalledTimes(2)
    await act(async () => {
      const pack = container.querySelector<HTMLSelectElement>('[data-testid="evolution-pack"]')
      if (pack === null) throw new Error('evolution target selector is absent')
      setValue(pack, `${packRef.id}:${packRef.version}:${packRef.digest}`)
    })
    await act(async () => { await Promise.resolve() })
    const reason = container.querySelector<HTMLInputElement>('input')
    const check = container.querySelector<HTMLInputElement>('.project-confirmation input')
    if (reason === null || check === null) throw new Error('evolution reason or review confirmation is absent')
    await act(async () => {
      setValue(reason, 'retry with a new version')
      check.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="evolution-start"]')?.click()
      await Promise.resolve()
    })
    expect(api.startProjectEvolution).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('等待人工审核')

    await act(async () => { lateOldRead.resolve(evolution(oldId, 'cancelled')); await lateOldRead.promise })
    expect(container.textContent).toContain(newId)
    expect(container.textContent).toContain('等待人工审核')
    expect(container.textContent).not.toContain('已取消')
  })
})
