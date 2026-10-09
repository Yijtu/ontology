import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CompetencyRunner, competencyExecutionRequest } from '@ontology/application'
import { createCompetencyQuestionBoundary, createRequestToolContext } from '@ontology/app-api'
import type { CompetencyExecutionRequest, CompetencyExecutionResult, CompetencyExpectation, CompetencyQuestionSet, VersionRef } from '@ontology/contracts'
import { loadCompetencyQuestions } from '../fixtures/competency-questions/loader'
import { COMPETENCY_ASSETS, CQ_ADDITIONAL_SOURCES, COMPETENCY_SCOPE, competencyDigest } from '../fixtures/competency-questions/assets'

const context = () => createRequestToolContext({ principal: { tenantId: COMPETENCY_SCOPE.tenantId, subjectId: 'unit-cq-controller', roles: ['platform-admin'], scopes: [], authEpoch: 1 }, spaceId: COMPETENCY_SCOPE.spaceId, traceId: randomUUID(), runId: randomUUID() })
function setFor(id = 'transport-attribute'): CompetencyQuestionSet {
  const set = structuredClone(loadCompetencyQuestions()[0]!)
  set.body.questions = set.body.questions.filter((question) => question.questionId === id)
  set.ref.digest = competencyDigest(set.body)
  return set
}
function originals(): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>()
  for (const [industry, assets] of Object.entries(COMPETENCY_ASSETS)) result.set(assets.document.ref.digest, readFileSync(new URL(`../fixtures/competency-questions/${industry}.source.txt`, import.meta.url)))
  for (const source of CQ_ADDITIONAL_SOURCES) result.set(source.document.ref.digest, readFileSync(new URL(`../fixtures/competency-questions/${source.filename}`, import.meta.url)))
  return result
}
function boundaryHarness(options: { readonly set?: CompetencyQuestionSet; readonly execute?: (request: CompetencyExecutionRequest, signal: AbortSignal) => Promise<CompetencyExecutionResult>; readonly afterApproval?: () => boolean } = {}) {
  const set = options.set ?? setFor()
  const sourceBytes = originals()
  let approvalReads = 0
  const calls: CompetencyExecutionRequest[] = []
  const complete = (request: CompetencyExecutionRequest, actual: CompetencyExpectation = { kind: 'value', value: { amount: '12.5', unit: 'm' } }): CompetencyExecutionResult => ({ status: 'executed', actual, inputDigest: request.inputDigest, definitionRef: request.definitionRef, ruleRefs: request.ruleRefs,
    artifactRefs: [{ id: '77777777-7777-4777-8777-777777777777', version: '1.0.0', digest: set.ref.digest, kind: 'artifact' }], sources: request.requiredSources })
  const schema = createCompetencyQuestionBoundary()
  const runner = new CompetencyRunner({ ...schema, questions: { readApproved: async () => { approvalReads += 1; return approvalReads === 1 || options.afterApproval?.() !== false ? structuredClone(set) : undefined } },
    sources: { readSource: async (_scope, ref) => sourceBytes.get(ref.digest) },
    execution: { execute: async (request, _ctx, signal) => { calls.push(request); return options.execute === undefined ? complete(request) : options.execute(request, signal) } } })
  return { runner, set, calls, complete, sourceBytes }
}

describe('CQ comparison boundary (unit ports, not real capability acceptance)', () => {
  it('passes only an intact exact result and never hands gold, derivation or assertion of approval to execution', async () => {
    const h = boundaryHarness()
    const report = await h.runner.run(h.set.ref, context(), new AbortController().signal)
    expect(report.passed).toBe(true)
    expect(h.calls[0]).not.toHaveProperty('expected')
    expect(h.calls[0]).not.toHaveProperty('derivation')
    expect(h.calls[0]).not.toHaveProperty('approved')
    expect(h.calls[0]?.inputDigest).toBe(competencyExecutionRequest(h.set.ref, h.set.body.questions[0]!).inputDigest)
    expect(report.externalAcceptance).toEqual({ customerQuote: 'unverified', liveModelQuality: 'unverified' })
  })
  it('keeps not_yet_executable required, visible, and deployment-blocking', async () => {
    const h = boundaryHarness({ execute: async () => ({ status: 'not_yet_executable', reason: 'actual published pipeline is not mounted' }) })
    const report = await h.runner.run(h.set.ref, context(), new AbortController().signal)
    expect(report.passed).toBe(false)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.status).toBe('not_yet_executable')
  })
  it('requires every original source and a real execution artifact rather than value equality alone', async () => {
    const h: ReturnType<typeof boundaryHarness> = boundaryHarness({ execute: async (request) => ({ ...h.complete(request), artifactRefs: [], sources: [] }) })
    const report = await h.runner.run(h.set.ref, context(), new AbortController().signal)
    expect(report.passed).toBe(false)
    expect(report.results[0]?.status).toBe('failed')
    expect(report.results[0]?.sourceCoverage.complete).toBe(false)
  })
  it.each(['input', 'definition', 'rule'] as const)('refuses an execution that changes the exact %s pin', async (changed) => {
    const h: ReturnType<typeof boundaryHarness> = boundaryHarness({ execute: async (request) => ({ ...h.complete(request),
      ...(changed === 'input' ? { inputDigest: `sha256:${'f'.repeat(64)}` } : changed === 'definition' ? { definitionRef: { ...request.definitionRef, version: '99.0.0' } } : { ruleRefs: [{ id: 'wrong', version: '1.0.0', digest: `sha256:${'f'.repeat(64)}` }] }) }) })
    await expect(h.runner.run(h.set.ref, context(), new AbortController().signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
  })
  it('refuses original-byte mutation and a source permission/review loss during execution', async () => {
    const changed = boundaryHarness()
    const ref = changed.set.body.questions[0]!.requiredSources[0]!.sourceRef
    changed.sourceBytes.set(ref.digest, new TextEncoder().encode('changed original'))
    await expect(changed.runner.run(changed.set.ref, context(), new AbortController().signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    const revoked = boundaryHarness({ afterApproval: () => false })
    await expect(revoked.runner.run(revoked.set.ref, context(), new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_APPROVED' })
  })
  it('does not publish a late report when cancellation is accepted inside execution', async () => {
    const controller = new AbortController()
    const h: ReturnType<typeof boundaryHarness> = boundaryHarness({ execute: async (request) => { controller.abort(); return h.complete(request) } })
    await expect(h.runner.run(h.set.ref, context(), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('compares exact decimal quantity axes without treating categorical numeric strings as quantities', async () => {
    const h: ReturnType<typeof boundaryHarness> = boundaryHarness({ execute: async (request) => h.complete(request, { kind: 'value', value: { amount: '12.500', unit: 'm' } }) })
    expect((await h.runner.run(h.set.ref, context(), new AbortController().signal)).passed).toBe(true)
    const text = boundaryHarness({ execute: async (request) => ({ status: 'executed', actual: { kind: 'value', value: '12.5' }, inputDigest: request.inputDigest, definitionRef: request.definitionRef,
      ruleRefs: request.ruleRefs, sources: request.requiredSources, artifactRefs: [{ id: '88888888-8888-4888-8888-888888888888', version: '1.0.0', digest: request.inputDigest, kind: 'artifact' }] }) })
    expect((await text.runner.run(text.set.ref, context(), new AbortController().signal)).passed).toBe(false)
  })
  it('includes only server-resolved target pins in the execution digest', () => {
    const set = setFor()
    const target = { workspaceId: randomUUID(), revision: '7', definitionApprovalPins: [], ruleActionPins: [] }
    const first = competencyExecutionRequest(set.ref, set.body.questions[0]!, target)
    const next = competencyExecutionRequest(set.ref, set.body.questions[0]!, { ...target, revision: '8' })
    expect(first.inputDigest).not.toBe(next.inputDigest)
    expect(first.validationTarget).toEqual(target)
    expect(first).not.toHaveProperty('expected')
    expect(set.ref).toMatchObject({ version: '1.1.0' } satisfies Partial<VersionRef>)
  })
})
