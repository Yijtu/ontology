// @vitest-environment jsdom
// UI wire/state tests. These do not replace the normal-host PostgreSQL and browser acceptance proof.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProjectEvolutionRecord,
  ProjectRecordVersion,
  PublishedAnswer,
  ResourceRef,
  SourceLocator,
} from '@ontology/contracts'
import {
  PublishedAnswerBody,
  isAnswerSourceView,
  isProjectEvolutionRecord,
  isProjectSourceCatalogue,
  normalizedInstanceValue,
  readAnswerSource,
  readProjectSources,
  stageProjectFacts,
  startProjectEvolution,
  readProjectEvolution,
  operateProjectEvolution,
  VerifiedCell,
  AnswerSourceContent,
  initialQueryState,
  queryReducer,
} from '@ontology/app-web'
import type { AnswerSourceView } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const SHA = `sha256:${'a'.repeat(64)}`
const PROJECT = '10000000-0000-4000-8000-000000000001'
const DOCUMENT = '10000000-0000-4000-8000-000000000002'
const PARSE = '10000000-0000-4000-8000-000000000003'
const RECORD = '10000000-0000-4000-8000-000000000004'
const CANDIDATE = '10000000-0000-4000-8000-000000000005'
const JOB = '10000000-0000-4000-8000-000000000006'
const EVOLUTION = '10000000-0000-4000-8000-000000000007'
const ANSWER = '10000000-0000-4000-8000-000000000008'
const EVIDENCE: ResourceRef = {
  id: '10000000-0000-4000-8000-000000000009',
  version: '1.0.0',
  digest: SHA,
  kind: 'evidence',
}
const ORIGINAL: ResourceRef = { id: DOCUMENT, version: '1.0.0', digest: SHA, kind: 'document' }
const LOCATOR: SourceLocator = {
  kind: 'table_cell',
  format: 'xlsx',
  sheetName: '原始台账',
  sheetId: 'sheet2',
  recordIndex: 1,
  row: 3,
  column: 2,
  address: 'B3',
  normalizationMapRef: 'saved-native-map',
}
const EXACT = '9007199254740993.00000000000000000001'
const MAPPING = {
  id: '10000000-0000-4000-8000-000000000010',
  version: '1.0.0',
  digest: SHA,
  role: 'catalog' as const,
  sourceObjectRef: { sourceRef: { namespace: 'project-import', sourceId: DOCUMENT }, objectPath: 'device' },
}
const ROW: ProjectRecordVersion = {
  schemaVersion: 'project-record@1',
  projectId: PROJECT,
  recordId: RECORD,
  revision: '1',
  mappingId: MAPPING.id,
  mappingVersion: MAPPING.version,
  objectId: 'device',
  sourceRowKey: 'actual-selected-row',
  sourceDigest: SHA,
  contentDigest: SHA,
  fields: [
    {
      fieldId: 'power',
      raw: EXACT,
      normalized: { kind: 'quantity', value: EXACT, unitCode: 'kW' },
      status: 'confirmed',
      locator: LOCATOR,
    },
  ],
  status: 'confirmed',
  actor: 'human',
  recordedAt: '2026-10-09T00:00:00Z',
}
const mappingRef = { ...MAPPING, version: '2.0.0' }
const plan: ProjectEvolutionRecord = {
  plan: {
    evolutionId: EVOLUTION,
    jobId: JOB,
    previousRevisionRef: { projectId: PROJECT, revision: '1', digest: SHA },
    targetRevisionRef: { projectId: PROJECT, revision: '2', digest: SHA },
    strategy: { kind: 'new_version', reason: '独立编写的演进检查' },
    impacts: [
      { kind: 'attribute', logicalId: 'device.reading', change: 'added', handling: 'reextract_review' },
    ],
    sources: [
      {
        documentId: DOCUMENT,
        membershipRevision: '1',
        visibilityEpoch: '1',
        originalRef: ORIGINAL,
        parseId: PARSE,
        previousMappingRef: MAPPING,
        mappingRef,
        objectId: 'device',
        expectedRecords: 1,
        sourceJobId: JOB,
        rawRecordCount: 1,
        recordIds: [RECORD],
        previousStatements: [{ statementId: CANDIDATE, version: '1' }],
      },
    ],
    maxAttempts: 1,
    maxRecordOperations: 2000,
    maxBatches: 1,
    requestDigest: SHA,
  },
  revision: '1',
  state: 'queued',
  attempts: 0,
  recordOperations: 0,
  batches: 0,
  candidateIds: [],
}
const source: AnswerSourceView = {
  answerId: ANSWER,
  evidenceId: EVIDENCE.id,
  answerRef: { id: ANSWER, version: '1.0.0', digest: SHA },
  evidenceRef: EVIDENCE,
  family: 'structured_qa',
  precision: 'approximate',
  readability: 're_readable',
  title: '原始台账中的相关单元格',
  cells: [{ raw: EXACT, locator: LOCATOR, columnLabel: '原始功率' }],
  originalRef: ORIGINAL,
  parseRef: { id: PARSE, version: '1.0.0', digest: SHA, kind: 'artifact' },
  dataMode: 'observed',
}
const assertionId = '10000000-0000-4000-8000-000000000011'
const answer: PublishedAnswer = {
  answerId: ANSWER,
  runId: JOB,
  draftId: PARSE,
  verificationId: EVOLUTION,
  contentHash: SHA,
  evidenceManifestHash: SHA,
  scenarioManifestHash: SHA,
  publicationKind: 'verified',
  publishedAt: '2026-10-09T00:00:00Z',
  limitations: ['incomplete-evidence'],
  body: {
    schemaVersion: 'answer-draft@2',
    blocks: [{ kind: 'assertion', assertionId }],
    claims: [],
    assertions: [
      {
        kind: 'artifact_summary',
        assertionId,
        subject: 'device',
        predicate: 'document_summary',
        artifactRef: { id: PARSE, version: '1.0.0', digest: SHA, kind: 'artifact' },
        summary: 'UNTRUSTED_FREE_SUMMARY_MUST_NEVER_RENDER',
        references: [
          {
            evidenceRef: EVIDENCE,
            resultDigest: SHA,
            valuePointer: '/spans/0/text',
            subjectPointer: '/spans/0/documentRef/id',
          },
        ],
      },
    ],
  },
}
const mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = []
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})
async function renderAnswer(view: unknown) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const client = new WorkbenchClient({
    baseUrl: 'http://api.test',
    fetchImpl: () => Promise.resolve(json(view)),
  })
  await act(async () => {
    root.render(
      createElement(PublishedAnswerBody, {
        answer,
        loadSource: (fixed, reference, signal) => client.getAnswerSource(fixed, reference, signal),
      }),
    )
  })
  return container
}

describe('fixed answer source guards', () => {
  it('requests only the clicked saved table cell and refuses a different or omitted selector echo', async () => {
    const selector = { tableId: 'actual-table', rowKey: 'opaque-saved-row-1001', columnRef: 'power' }
    const view: AnswerSourceView = {
      answerId: ANSWER, evidenceId: EVIDENCE.id, answerRef: source.answerRef, evidenceRef: EVIDENCE,
      family: 'data_query', precision: 'exact', readability: 'archived_snapshot_only', title: '所选字段的固定输入', dataMode: 'observed', selectedCell: selector,
      sourceCoverage: { mode: 'saved_cell', requested: 1, verified: 1, displayed: 1, knownTotal: 1, truncated: false, coverage: 'complete', maxRows: 10, maxFragments: 10 },
      fragments: [{ precision: 'exact', originalRef: ORIGINAL, parseRef: source.parseRef!, locator: LOCATOR, cells: source.cells! }],
      sourceReadLimitation: '原始值保留导入时的单位与完整小数字符串。',
    }
    let path = ''
    const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: (input) => { path = String(input); return Promise.resolve(json(view)) } })
    expect(await readAnswerSource(client, answer, EVIDENCE, undefined, selector)).toEqual(view)
    const url = new URL(path)
    expect([...url.searchParams.entries()]).toEqual(Object.entries(selector))
    for (const selectedCell of [undefined, { ...selector, rowKey: 'another-row' }, { ...selector, columnRef: 'different-field' }, { ...selector, latest: true }]) {
      const wrong = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: () => Promise.resolve(json({ ...view, selectedCell })) })
      await expect(readAnswerSource(wrong, answer, EVIDENCE, undefined, selector)).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_MISMATCH' })
    }
    await expect(readAnswerSource(client, answer, EVIDENCE)).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_MISMATCH' })
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => root.render(createElement(AnswerSourceContent, { view })))
    expect(container.textContent).toContain('对应所选结果单元格')
    expect(container.textContent).toContain(EXACT)
    expect(container.textContent).not.toContain('暂不支持回读原始表格单元格')
    expect(container.textContent).toContain('核验时保存的固定来源')
    await act(async () => container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[data-testid="original-cell-location"]')?.textContent).toContain('B3')
  })
  it('labels bounded aggregate inputs and folds exact input artifacts; malformed coverage and enum arrays refuse', async () => {
    const view: AnswerSourceView = {
      answerId: ANSWER, evidenceId: EVIDENCE.id, answerRef: source.answerRef, evidenceRef: EVIDENCE,
      family: 'data_query', precision: 'exact', readability: 're_readable', title: '计算固定输入来源', dataMode: 'observed',
      sourceCoverage: { mode: 'compute_input_sample', requested: 10, verified: 10, displayed: 10, knownTotal: 1001, truncated: true, coverage: 'partial', maxRows: 10, maxFragments: 10 },
      fragments: [{ precision: 'exact', originalRef: ORIGINAL, parseRef: source.parseRef!, locator: LOCATOR, cells: source.cells! }],
      inputArtifacts: [{ ref: source.parseRef!, byteSize: 20_000, inputRefPointers: ['/inputRefs/0'], text: 'SAVED_INPUT_PREFIX', textTruncated: true }],
    }
    expect(isAnswerSourceView(view)).toBe(true)
    for (const sourceCoverage of [{ ...view.sourceCoverage, truncated: false }, { ...view.sourceCoverage, displayed: 11 }, { ...view.sourceCoverage, mode: ['compute_input_sample'] }, { ...view.sourceCoverage, coverage: ['partial'] }])
      expect(isAnswerSourceView({ ...view, sourceCoverage })).toBe(false)
    expect(isAnswerSourceView({ ...view, inputArtifacts: [{ ...view.inputArtifacts![0], inputRefPointers: ['/arbitrary/source'] }] })).toBe(false)
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => root.render(createElement(AnswerSourceContent, { view })))
    expect(container.textContent).toContain('共 1001 条')
    expect(container.textContent).toContain('展示 10 条')
    expect(container.textContent).toContain('不能视为全部来源')
    expect(container.textContent).toContain('不与某一个原始单元格一一对应')
    const details = container.querySelector<HTMLDetailsElement>('[data-testid="query-source-archive"]')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('SAVED_INPUT_PREFIX')
    expect(details?.textContent).toContain('仅显示开头部分')
  })
  it('refuses coercible array enums before any source or archived text is rendered', async () => {
    for (const key of ['family', 'precision', 'readability', 'dataMode'] as const) {
      const malformed = { ...source, [key]: [source[key]], text: 'ARRAY_ENUM_SOURCE_MUST_NOT_RENDER' }
      expect(isAnswerSourceView(malformed)).toBe(false)
      const container = await renderAnswer(malformed)
      expect(container.textContent).not.toContain(EXACT)
      expect(container.textContent).not.toContain('ARRAY_ENUM_SOURCE_MUST_NOT_RENDER')
      expect(container.textContent).not.toContain('UNTRUSTED_FREE_SUMMARY')
    }
    expect(isAnswerSourceView({ ...source, cells: [{ ...source.cells![0], locator: { ...LOCATOR, format: ['xlsx'] } }] })).toBe(false)
  })
  it('renders the actual formal-table quantity shape with its exact 18-decimal string and actual unit', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    await act(async () => root.render(createElement(VerifiedCell, { value: { value: '9.000000000000000001', unit: 'kWh' }, valueType: 'quantity' })))
    expect(container.textContent).toBe('9.000000000000000001 kWh')
    expect(container.textContent).not.toContain('暂不可展示')
  })
  it('does not revive cancellation when a replay batch also contains a late publication', () => {
    const state = queryReducer(initialQueryState(), { type: 'runEvents', events: [{ id: 'cancel', event: 'run.state', data: { state: 'cancelled' } }, { id: 'late', event: 'answer.published', data: { publicationKind: 'verified' } }] })
    expect(state.outcome).toBe('cancelled')
    expect(state.answerState).toBe('none')
    expect(state.events).toHaveLength(1)
  })
  it('shows actual typed cells honestly as approximate and never reproduces the free summary', async () => {
    const container = await renderAnswer(source)
    expect(container.querySelector('[data-testid="published-structured-qa"]')?.textContent).toContain(EXACT)
    expect(container.textContent).toContain('近似投影')
    expect(container.textContent).not.toContain('UNTRUSTED_FREE_SUMMARY')
    expect(container.textContent).not.toContain('精确引文')
  })
  it('keeps separate originals and selected cells for every actual answer fragment', async () => {
    const secondRef: ResourceRef = { ...ORIGINAL, id: '10000000-0000-4000-8000-000000000012', digest: `sha256:${'b'.repeat(64)}` }
    const secondLocator: SourceLocator = { ...LOCATOR, sheetName: '第二份台账', sheetId: 'sheet3', row: 14, address: 'B14' }
    const first = { precision: 'approximate' as const, originalRef: ORIGINAL, parseRef: source.parseRef!, locator: LOCATOR, cells: source.cells! }
    const second = { precision: 'approximate' as const, originalRef: secondRef, parseRef: { id: 'second-parse', version: '1.0.0', digest: secondRef.digest, kind: 'artifact' as const }, locator: secondLocator, cells: [{ raw: '12000.000000000000001', locator: secondLocator, columnLabel: '另一份资料功率' }] }
    const view = { ...source, locator: LOCATOR, fragments: [first, second] }
    expect(isAnswerSourceView(view)).toBe(true)
    expect(isAnswerSourceView({ ...view, originalRef: secondRef })).toBe(false)
    expect(isAnswerSourceView({ ...view, fragments: [{ ...first, cells: [{ raw: 'forged', locator: LOCATOR }] }, second] })).toBe(false)
    const container = await renderAnswer(view)
    const fragments = [...container.querySelectorAll('[data-testid="answer-source-fragment"]')]
    expect(fragments).toHaveLength(2)
    expect(fragments[0]?.textContent).toContain(EXACT)
    expect(fragments[0]?.textContent).toContain(ORIGINAL.id)
    expect(fragments[0]?.textContent).not.toContain(secondRef.id)
    expect(fragments[1]?.textContent).toContain(secondRef.id)
    expect(fragments[1]?.textContent).not.toContain(ORIGINAL.id)
    const locate = fragments[1]?.querySelector('button')
    if (locate === null || locate === undefined) throw new Error('the second original cell action is missing')
    await act(async () => { locate.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(fragments[1]?.querySelector('[data-testid="original-cell-location"]')?.textContent).toContain('12000.000000000000001')
    expect(fragments[1]?.querySelector('[data-testid="original-cell-location"]')?.textContent).toContain('B14')
    expect(fragments[0]?.querySelector('[data-testid="original-cell-location"]')).toBeNull()
  })
  it('refuses forged exact structured QA and suppresses unreadable original cells', async () => {
    expect(isAnswerSourceView({ ...source, precision: 'exact' })).toBe(false)
    expect(isAnswerSourceView({ ...source, originalRef: undefined })).toBe(false)
    expect(
      isAnswerSourceView({ ...source, cells: [{ raw: EXACT, locator: { ...LOCATOR, column: 0 } }] }),
    ).toBe(false)
    const container = await renderAnswer({ ...source, readability: 'unverifiable' })
    expect(container.textContent).toContain('当前无法核验')
    expect(container.textContent).not.toContain(EXACT)
    expect(container.textContent).not.toContain('UNTRUSTED_FREE_SUMMARY')
  })
  it('rejects a different fixed answer hash or bound full evidence ref', async () => {
    for (const changed of [
      { ...source, answerRef: { ...source.answerRef, digest: `sha256:${'b'.repeat(64)}` } },
      { ...source, evidenceRef: { ...EVIDENCE, version: '2.0.0' } },
    ]) {
      const client = new WorkbenchClient({
        baseUrl: 'http://api.test',
        fetchImpl: () => Promise.resolve(json(changed)),
      })
      await expect(readAnswerSource(client, answer, EVIDENCE)).rejects.toMatchObject({
        code: 'SOURCE_REFERENCE_MISMATCH',
      })
    }
  })
})

describe('stored-record staging and evolution wire contract', () => {
  it('binds GET and every evolution operation to the exact requested plan ID', async () => {
    const wrongId = '10000000-0000-4000-8000-000000000099'
    const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: () => Promise.resolve(json({ evolution: { ...plan, plan: { ...plan.plan, evolutionId: wrongId } } })) })
    await expect(readProjectEvolution(client, PROJECT, EVOLUTION)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    for (const operation of ['activate', 'cancel', 'retry'] as const)
      await expect(operateProjectEvolution(client, PROJECT, EVOLUTION, operation)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('stages only document and exact saved row selectors and checks returned candidate correlation', async () => {
    let submitted: unknown
    const candidate = {
      kind: 'entity',
      candidateId: CANDIDATE,
      jobId: JOB,
      objectId: 'device',
      attributes: [{ attributeId: 'power', value: EXACT }],
      sourceSpans: [{ kind: 'structured', parseId: PARSE }],
      inputVersion: {
        definitionRef: { id: 'definition', version: '1.0.0', digest: SHA },
        projectFact: {
          sources: [
            {
              documentId: DOCUMENT,
              recordId: RECORD,
              recordRevision: '1',
              projectRevisionRef: { projectId: PROJECT, revision: '1', digest: SHA },
            },
          ],
        },
      },
    }
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (_input, init) => {
        submitted = JSON.parse(String(init?.body))
        return Promise.resolve(json({ candidates: [candidate] }))
      },
    })
    expect(await stageProjectFacts(client, PROJECT, DOCUMENT, [ROW], 'retained-stage-key')).toEqual([
      { candidateId: CANDIDATE, jobId: JOB, objectId: 'device', documentId: DOCUMENT },
    ])
    expect(submitted).toEqual({ documentId: DOCUMENT, recordRefs: [{ recordId: RECORD, revision: '1' }] })
    const wrong = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () =>
        Promise.resolve(
          json({
            candidates: [
              {
                ...candidate,
                inputVersion: {
                  ...candidate.inputVersion,
                  projectFact: {
                    sources: [
                      {
                        documentId: EVOLUTION,
                        recordId: RECORD,
                        recordRevision: '1',
                        projectRevisionRef: { projectId: PROJECT },
                      },
                    ],
                  },
                },
              },
            ],
          }),
        ),
    })
    await expect(
      stageProjectFacts(wrong, PROJECT, DOCUMENT, [ROW], 'retained-stage-key'),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('uses the existing evolution route, exact If-Match and declared original mapping; foreign or empty plans refuse', async () => {
    let url = '',
      revision: string | null = null,
      key: string | null = null
    let submitted: unknown
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input, init) => {
        url = String(input)
        const headers = new Headers(init?.headers)
        revision = headers.get('if-match')
        key = headers.get('idempotency-key')
        submitted = JSON.parse(String(init?.body))
        return Promise.resolve(json({ evolution: plan }))
      },
    })
    const body = {
      industryPackRef: { id: 'published-pack', version: '2.0.0', digest: SHA },
      strategy: { kind: 'new_version' as const, reason: '实际原始资料重抽取' },
      remappings: [
        {
          mappingRef: MAPPING,
          documentId: DOCUMENT,
          objectId: 'device',
          entries: [
            {
              fieldRef: 'power',
              columnIndex: 1,
              header: '原始功率',
              headerDigest: SHA,
              sourceUnitCode: 'kW',
              canonicalUnitCode: 'kW',
            },
          ],
        },
      ],
      maxRecords: 2000,
      maxAttempts: 1,
    }
    expect(await startProjectEvolution(client, PROJECT, '1', body, 'retained-evolution-key')).toEqual(plan)
    expect(url).toBe(`http://api.test/api/v1/projects/${PROJECT}/evolutions`)
    expect(revision).toBe('1')
    expect(key).toBe('retained-evolution-key')
    expect(submitted).toEqual(body)
    expect(isProjectEvolutionRecord({ ...plan, plan: { ...plan.plan, sources: [] } })).toBe(false)
    const foreign = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () =>
        Promise.resolve(
          json({
            evolution: {
              ...plan,
              plan: {
                ...plan.plan,
                targetRevisionRef: { ...plan.plan.targetRevisionRef, projectId: DOCUMENT },
              },
            },
          }),
        ),
    })
    await expect(
      startProjectEvolution(foreign, PROJECT, '1', body, 'retained-evolution-key'),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('rejects a forged foreign project catalogue rather than offering it for mapping', async () => {
    const data = {
      project: {
        projectId: DOCUMENT,
        title: '其他合法项目',
        headRevision: '1',
        state: 'active',
        createdBy: 'other',
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T00:00:00Z',
      },
      revision: {
        ref: { projectId: DOCUMENT, revision: '1', digest: SHA },
        industryPackRef: { id: 'pack', version: '1.0.0', digest: SHA },
        definitionRef: { id: 'definition', version: '1.0.0', digest: SHA },
        profileRef: { id: 'profile', version: '1.0.0', snapshotHash: SHA },
        mappingRefs: [],
        documentSetRef: { id: PARSE, version: '1.0.0', digest: SHA, kind: 'artifact' },
        semanticPublicationRefs: [],
        sourceVisibilityEpoch: '1',
        changeReason: '合法的独立项目上下文',
      },
      sources: [],
      objects: [],
    }
    expect(isProjectSourceCatalogue(data)).toBe(true)
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () => Promise.resolve(json(data)),
    })
    await expect(readProjectSources(client, PROJECT)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('never converts an unselected or arbitrary boolean string into false', () => {
    for (const value of ['', 'yes', '0'])
      expect(() =>
        normalizedInstanceValue({ kind: 'scalar', scalarType: 'boolean', value, unitCode: '' }),
      ).toThrow('请选择是或否')
    expect(
      normalizedInstanceValue({ kind: 'scalar', scalarType: 'boolean', value: 'false', unitCode: '' }),
    ).toEqual({ kind: 'scalar', value: false })
  })
})
