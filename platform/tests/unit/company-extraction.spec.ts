import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ExtractionPipeline, InMemoryCandidateStore, InMemoryIndustrySchemaSource } from '@ontology/application'
import type { EvidenceEnvelope, EvidenceStorePort, ResourceRef } from '@ontology/contracts'
import { createCompanyExtractionGeneration } from '../../apps/api/src/composition/company-extraction'
import { createRequestToolContext } from '../../apps/api/src/http/context'
import { createBudgetHarness, SCOPE_A } from './job-fixtures'
import { buildIndustrySchema, chunkOf, DEFINITION_REF } from './extraction-fixtures'

const LEDGER_ID = randomUUID()

function evidenceHarness(): { readonly store: EvidenceStorePort; readonly recorded: EvidenceEnvelope[] } {
  const recorded: EvidenceEnvelope[] = []
  return {
    recorded,
    store: {
      async record(_scope, envelope) {
        recorded.push(envelope)
        const evidenceRef: ResourceRef = { id: envelope.evidenceId, kind: 'evidence', version: '1.0.0', digest: envelope.integrity.digest }
        return { evidenceRef, envelope, envelopeDigest: envelope.integrity.digest, revision: '1', recordedAt: envelope.observedAt }
      },
      async get() { return undefined },
      async listByRun() { return [] },
    },
  }
}

describe('optional company model candidate extraction', () => {
  it('is disabled when the model endpoint is not configured and rejects partial configuration', () => {
    const budget = createBudgetHarness()
    const evidence = evidenceHarness()
    expect(createCompanyExtractionGeneration({ budget: budget.budget, evidence: evidence.store, env: {} })).toBeUndefined()
    expect(() => createCompanyExtractionGeneration({ budget: budget.budget, evidence: evidence.store, env: { ONTOLOGY_EXTRACTION_VENDOR_MODEL: 'fake' } })).toThrow('configure both')
  })

  it('extracts schema-bound review candidates through the model adapter with one shared ledger charge', async () => {
    const budget = createBudgetHarness()
    const evidence = evidenceHarness()
    const context = createRequestToolContext({
      principal: { tenantId: SCOPE_A.tenantId, subjectId: 'extractor-test', roles: ['data-editor'], scopes: [], authEpoch: 1 },
      spaceId: SCOPE_A.spaceId, runId: randomUUID(), traceId: 'company-extraction-test',
    })
    await budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background', runId: context.runId }, context)
    const payload = JSON.stringify({ entities: [{ objectId: 'device', attributes: [
      { attributeId: 'device_native_id', value: 'DEV-7' }, { attributeId: 'device_kind', value: 'charger' },
    ] }], relations: [], rules: [], exceptions: [] })
    const sse = [
      { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'vendor-test', choices: [{ index: 0, delta: { content: payload }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'vendor-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 18, total_tokens: 39 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const configured = createCompanyExtractionGeneration({
      budget: budget.budget, evidence: evidence.store, fetchImpl,
      env: {
        ONTOLOGY_COMPANY_MODEL_BASE_URL: 'https://company.example/v1',
        ONTOLOGY_COMPANY_MODEL_ENDPOINT: 'chat/completions',
        ONTOLOGY_EXTRACTION_VENDOR_MODEL: 'vendor-test',
        ONTOLOGY_COMPANY_MODEL_API_KEY: 'fake-unit-test-key',
      },
    })
    expect(configured).toBeDefined()
    if (configured === undefined) throw new Error('test setup did not configure the model')
    const candidates = new InMemoryCandidateStore()
    const pipeline = new ExtractionPipeline({
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
      generation: configured.create(LEDGER_ID, new AbortController().signal), candidates, budget: budget.budget,
      modelRef: configured.modelRef, outputLimit: configured.outputLimit, generationAccountsUsage: true,
    })
    const chunk = chunkOf('设备 DEV-7 是充电器。', 0)
    const result = await pipeline.extract({
      jobId: randomUUID(), parseId: randomUUID(), parserVersion: '1.0.0', pipelineVersion: '1.0.0',
      definitionRef: DEFINITION_REF, chunks: [chunk], truncatedChunkIds: [],
    }, { ledgerId: LEDGER_ID, ctx: context, signal: new AbortController().signal })
    expect(result.modelCalls).toBe(1)
    expect(result.candidateIds).toHaveLength(1)
    expect(calls).toBe(1)
    expect(evidence.recorded).toHaveLength(1)
    expect(evidence.recorded[0]?.kind).toBe('model_output')
    expect(evidence.recorded[0]?.producedBy.runId).toBe(LEDGER_ID)
    const reservations = await budget.store.listReservations(SCOPE_A, LEDGER_ID, context)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
  })
})
