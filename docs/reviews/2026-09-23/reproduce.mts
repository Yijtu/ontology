import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { DraftVerificationService } from '../../../platform/packages/application/src/index.ts'
import { createApiServer } from '../../../platform/apps/api/src/index.ts'
import { buildJevWireRequest, decodeJevWireResponse } from '../../../platform/packages/adapters/model-jev/src/vendor/jev-wire.ts'
import { JevHttpClient } from '../../../platform/packages/adapters/model-jev/src/http-client.ts'
import { decodeCompanyWireChunk } from '../../../platform/packages/adapters/model-company/src/vendor/company-wire.ts'
import { RuleEvaluator, supportRuleFromPublishedRule, PublishedSemanticSource } from '../../../platform/packages/semantic-engine/src/index.ts'
import {
  BLOB_ID, RESULT_PAYLOAD, RUN_ID, NOW, SCOPE_A,
  InMemoryVerificationArtifacts, InMemoryVerificationEvidence,
  FixedSemanticDecision, buildEvidence, buildClaim, buildDraft, buildInputManifest,
  verificationPolicy, modelRef, ownerContext as verificationContext,
} from '../../../platform/tests/unit/verification-fixtures.ts'
import {
  RUN_A, ScriptedRuntime, buildWorkflowHarness, planEvent, evidenceEvent,
  evidenceRef, collectionCompleteEvent, startInput, ownerContext,
} from '../../../platform/tests/unit/workflow-fixtures.ts'

// Diagnostic only: assertions confirm current defects; these are NOT regression acceptance tests.
// No external requests, credentials, customer data or production database are used.
const findings: Record<string, unknown>[] = []

const runtime = new ScriptedRuntime({ scripts: [[
  planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('a')]), collectionCompleteEvent(RUN_A),
]] })
const harness = buildWorkflowHarness({ runtime })
const ctx = ownerContext()
const app = createApiServer({
  authenticate: () => ({ principal: ctx.principal, spaceId: ctx.allowedResources.spaceId }),
  runs: { service: harness.service },
})
try {
  const input = startInput()
  const response = await app.inject({ method: 'POST', url: '/api/v1/runs',
    headers: { 'idempotency-key': 'review-http-only' },
    payload: { profileRef: input.profileRef, question: input.question, context: input.context, preferences: input.preferences },
  })
  assert.equal(response.statusCode, 202)
  const id = response.json().data.runId
  const state = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}` })
  assert.equal(state.json().data.state, 'created')
  assert.equal(runtime.startCalls.length, 0)
  findings.push({ id: 'HTTP-NO-DISPATCH', postStatus: response.statusCode, runState: state.json().data.state, runtimeStarts: runtime.startCalls.length })
} finally { await app.close() }

const completed = await harness.controller.startRun(startInput(), ctx)
assert.equal(completed.state, 'published')
const answer = await harness.controller.getAnswer(RUN_A, ctx)
assert.ok(answer)
assert.equal('blocks' in answer, false)
assert.equal('contentRef' in answer, false)
findings.push({ id: 'ANSWER-METADATA-ONLY', fields: Object.keys(answer) })
let retryError = 'NONE'
const retryId = randomUUID()
try { await harness.controller.startRun(startInput({ runId: retryId }), ownerContext(retryId)) }
catch (error) { retryError = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error) }
assert.equal(retryError, 'RUN_NOT_FOUND')
findings.push({ id: 'CONTROLLER-IDEMPOTENCY', sameKeyNewRunIdError: retryError })

const artifacts = new InMemoryVerificationArtifacts()
const evidence = new InMemoryVerificationEvidence()
const payloadRef = artifacts.put(BLOB_ID, RESULT_PAYLOAD)
const record = await evidence.record(SCOPE_A, buildEvidence({ payloadRef, resultDigest: payloadRef.digest }))
const claim = buildClaim({ evidenceRef: record.evidenceRef, resultDigest: payloadRef.digest })
const manifest = buildInputManifest([record.evidenceRef])
const service = new DraftVerificationService({ evidence, artifacts, policy: verificationPolicy(), now: () => NOW })
const fabricatedBody = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim],
  blocks: [{ kind: 'paragraph', text: 'The supported value is 9999 kWh and all source records prove it.' }],
})
const bodyVerdict = await service.verify({ runId: RUN_ID, draft: fabricatedBody, inputManifest: manifest }, verificationContext())
assert.equal(bodyVerdict.verdict, 'pass')
findings.push({ id: 'UNBOUND-ANSWER-BLOCKS', archivedValue: RESULT_PAYLOAD.value, bodyValue: 9999, verdict: bodyVerdict.verdict, failedChecks: bodyVerdict.failedChecks })

const unboundTimeClaim = { ...claim, time: { asOf: '2099-01-01T00:00:00Z' }, references: claim.references.map(({ timePointer: _ignored, ...rest }) => rest) }
const timeDraft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [unboundTimeClaim] })
const timeVerdict = await service.verify({ runId: RUN_ID, draft: timeDraft, inputManifest: manifest }, verificationContext())
assert.equal(timeVerdict.verdict, 'pass')
findings.push({ id: 'UNBOUND-CLAIM-TIME', archivedTime: RESULT_PAYLOAD.time, claimedTime: unboundTimeClaim.time.asOf, verdict: timeVerdict.verdict })

const decision = new FixedSemanticDecision('supported')
const semanticVerifier = new DraftVerificationService({ evidence, artifacts, policy: verificationPolicy(), decision, modelRef: modelRef(), now: () => NOW })
const goodDraft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
await semanticVerifier.verify({ runId: RUN_ID, draft: goodDraft, inputManifest: manifest }, verificationContext())
const sentRequest = decision.calls[0]
assert.ok(sentRequest)
const serialized = JSON.stringify(sentRequest)
assert.equal(serialized.includes(RESULT_PAYLOAD.subject), false)
assert.equal(serialized.includes('12.5'), false)
findings.push({ id: 'SEMANTIC-REVIEW-NO-CONTENT', sentRequest })

const question = sentRequest.questions[0]
const wire = buildJevWireRequest('jev-latest', sentRequest.stateRef, [question])
let calledPath = ''
const http = new JevHttpClient({ baseUrl: 'https://api.typesafe.ai', fetchImpl: async (url) => {
  calledPath = new URL(String(url)).pathname
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
} })
await http.send({ vendorModel: 'jev-latest', stateRef: sentRequest.stateRef, questions: [question], apiKey: 'local-placeholder', signal: new AbortController().signal })
const decoded = decodeJevWireResponse({ model: 'jev-example', answers: { q: { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 10, output_tokens: 1 } })
assert.equal(calledPath, '/v1/decide')
assert.equal('state' in wire, false)
assert.equal(Array.isArray(wire.questions), true)
assert.equal(decoded.kind, 'malformed')
findings.push({ id: 'JEV-PROTOCOL', actualPath: calledPath, topLevelKeys: Object.keys(wire), questionsIsArray: Array.isArray(wire.questions), officialResponseDecode: decoded })

const fact = (id: string, subject: string, predicate: string, value: boolean) => ({
  assertionId: id, logicalAssertionId: id, recordedSeq: '1', op: 'assert' as const,
  subject, predicate, value, validity: { validFrom: NOW }, sourceRef: { namespace: 'review', sourceId: id },
})
const compare = (attributeId: string) => ({ op: 'compare' as const, attributeId, operator: 'eq' as const, value: true, spans: [] })
const publishedRule = {
  ruleVersionId: randomUUID(), ruleId: 'review-rule', version: '1', objectId: 'battery',
  severity: 'hard' as const, impact: 'high' as const, expression: compare('enabled'),
  exceptions: [{ exceptionId: 'maintenance', condition: compare('maintenance'), spans: [] }],
  recordedAt: NOW, sourceCandidateId: randomUUID(), publicationId: randomUUID(),
}
const evalRequest = { scopeRef: SCOPE_A, projectionRef: { id: 'review', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }, validAt: NOW }
const evaluate = (rule: typeof publishedRule, facts: ReturnType<typeof fact>[]) => new RuleEvaluator().evaluate({
  scopeRef: SCOPE_A, request: evalRequest, facts, rules: [supportRuleFromPublishedRule(rule, facts)],
})
const exceptedFacts = [fact('enabled', 'battery-A', 'enabled', true), fact('maintenance', 'battery-A', 'maintenance', true)]
const exceptionResult = evaluate(publishedRule, exceptedFacts)
assert.equal(exceptionResult.conclusions[0]?.value, true)
findings.push({ id: 'RULE-EXCEPTION-IGNORED', exceptionIsTrue: true, conclusion: exceptionResult.conclusions[0] })
const crossFacts = [fact('a', 'battery-A', 'enabled', true), fact('b', 'battery-B', 'islanding', true)]
const crossRule = { ...publishedRule, exceptions: [], expression: { op: 'all' as const, operands: [compare('enabled'), compare('islanding')], spans: [] } }
const crossResult = new RuleEvaluator().evaluate({ scopeRef: SCOPE_A, request: evalRequest, facts: crossFacts, rules: [supportRuleFromPublishedRule(crossRule, crossFacts)] })
assert.equal(crossResult.conclusions[0]?.value, true)
findings.push({ id: 'RULE-CROSS-ENTITY', facts: crossFacts.map(({ subject, predicate }) => ({ subject, predicate })), conclusion: crossResult.conclusions[0] })

let statementReads = 0
const publishedStatements = Array.from({ length: 1001 }, (_, i) => ({
  statementId: `statement-${String(i).padStart(4, '0')}`, propositionKey: `p-${i}`, kind: 'entity' as const,
  objectId: 'battery', subjectEntityId: `battery-${i}`, predicate: 'enabled', value: { value: true },
  recordedAt: NOW, sourceCandidateId: randomUUID(), sourceRefs: [], publicationId: randomUUID(), version: '1', status: 'active' as const,
}))
const publishedSource = new PublishedSemanticSource({
  listStatements: async (_scope, filter) => { statementReads++; return publishedStatements.slice(0, filter.limit) },
  listRuleVersions: async () => [],
})
const loaded = await publishedSource.load(SCOPE_A, verificationContext())
assert.equal(loaded.facts.length, 1000)
assert.equal(statementReads, 1)
assert.equal('coverage' in loaded, false)
findings.push({ id: 'MATERIALIZATION-FIRST-PAGE', availableStatements: 1001, loadedFacts: loaded.facts.length, statementReads, resultFields: Object.keys(loaded) })

const companyChunk = { object: 'chat.completion.chunk', model: 'review-model', choices: [{ index: 0, delta: { content: 'review text' }, finish_reason: null }] }
assert.equal(decodeCompanyWireChunk(JSON.stringify(companyChunk)), undefined)
findings.push({ id: 'COMPANY-PROTOCOL', gatewayChunkKind: companyChunk.object, decoderAccepts: false })

await writeFile(new URL('./reproduce-results.json', import.meta.url), JSON.stringify(findings, null, 2) + '\n')
console.log(JSON.stringify(findings, null, 2))
