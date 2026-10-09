import { describe, expect, it } from 'vitest'
import { isIndustryValidationReportView } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const W = '11111111-1111-4111-8111-111111111111', V = '22222222-2222-4222-8222-222222222222', digest = `sha256:${'a'.repeat(64)}`
const legacy = { validationId: V, workspaceId: W, revision: '1', exampleSetId: V, exampleSetRef: { id: V, version: '1.0.0', digest, kind: 'dataset' }, dataMode: 'synthetic', isolationLabel: 'synthetic test', businessApproval: 'none', realFactsWritten: false, semanticPublished: { passed: true, blockers: [] }, deploymentExecutable: { passed: true, blockers: [] }, publishable: true, gate: 'open', issues: [], expectationResults: [], coverage: [], contentDigest: digest, recordedAt: '2026-10-09T00:00:00Z' }
const result = { questionId: 'cq-1', question: '是否需要复检？', status: 'passed', expected: { state: 'unknown' }, sourceCoverage: { required: 2, verified: 2, complete: true } }
const cq = { competencyQuestionRef: { id: V, version: '1.0.0', digest }, competencyRequired: true, competency: { passed: true, results: [result] } }
const clientFor = (validation: unknown) => new WorkbenchClient({ baseUrl: 'http://wire-boundary.test', fetchImpl: async () => new Response(JSON.stringify({ data: { validation } }), { headers: { 'content-type': 'application/json' } }) })

describe('actual industry-validation CQ response guard', () => {
  it('accepts legacy absence and a typed CQ report on the real report reader', async () => {
    expect(isIndustryValidationReportView(legacy)).toBe(true)
    expect(isIndustryValidationReportView({ ...legacy, ...cq })).toBe(true)
    expect(await clientFor(legacy).getValidation(W, V)).toEqual(legacy)
    expect(await clientFor({ ...legacy, ...cq }).getValidation(W, V)).toEqual({ ...legacy, ...cq })
  })

  const malformed: readonly { readonly name: string; readonly fields: Readonly<Record<string, unknown>> }[] = [
    { name: 'truthy passed string', fields: { competency: { passed: 'true', results: [] } } },
    { name: 'results object', fields: { competency: { passed: true, results: {} } } },
    { name: 'non-result array item', fields: { competency: { passed: true, results: [null] } } },
    { name: 'bad result status', fields: { competency: { passed: true, results: [{ ...result, status: 'ready' }] } } },
    { name: 'missing expected', fields: { competency: { passed: true, results: [{ ...result, expected: undefined }] } } },
    { name: 'bad CQ reference digest', fields: { competencyQuestionRef: { ...cq.competencyQuestionRef, digest: 'not-a-content-pin' } } },
    { name: 'bad CQ reference version', fields: { competencyQuestionRef: { ...cq.competencyQuestionRef, version: 2 } } },
    { name: 'false required marker', fields: { competencyRequired: false } },
    ...[
      { required: '2', verified: 2, complete: true },
      { required: 2, verified: 2, complete: 'true' },
      { required: 2, verified: -1, complete: false },
      { required: 2, verified: 0.5, complete: false },
      { required: 2, verified: 3, complete: true },
      { required: 2, verified: 1, complete: true },
    ].map((sourceCoverage, index) => ({ name: `malformed source coverage ${index}`, fields: { competency: { passed: true, results: [{ ...result, sourceCoverage }] } } })),
  ]
  it.each(malformed)('rejects $name before publication gating or results rendering', async ({ fields }) => {
    const value = { ...legacy, ...cq, ...fields }
    expect(isIndustryValidationReportView(value)).toBe(false)
    await expect(clientFor(value).getValidation(W, V)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
