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
async function renderAnswer(view: AnswerSourceView) {
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
