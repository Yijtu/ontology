import { describe, expect, it } from 'vitest'
import { runLiveValidation } from '../evaluation/live/live-model-validation'

/**
 * Deterministic double for the live harness (LOCAL-072). It proves the harness wires the
 * OpenAI-compatible codec through to the `GenerationPort` and that no resolved secret
 * value reaches the report. It is NOT a real-endpoint result; that run is operator-only.
 */

const FAKE_COMPANY_KEY = 'sk-fake-company-DO-NOT-LEAK-1234'
const FAKE_JEV_KEY = 'sk-fake-jev-DO-NOT-LEAK-5678'
const VENDOR_MODEL = 'deepseek-v4-1-flash-260910'

function openAiChunk(choices: readonly Record<string, unknown>[], usage?: Record<string, unknown>): string {
  const chunk = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: VENDOR_MODEL,
    choices,
    ...(usage === undefined ? {} : { usage }),
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** One OpenAI-compatible stream satisfying text, structured-output and tool-call probes. */
function openAiStream(): string {
  return [
    openAiChunk([{ index: 0, delta: { content: '{"answer":"a tariff is a price plan","' }, finish_reason: null }]),
    openAiChunk([{ index: 0, delta: { content: 'confidence":0.7}' }, finish_reason: null }]),
    openAiChunk([
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_live_fake', function: { name: 'data_query', arguments: '{"kind":"describe"}' } },
          ],
        },
        finish_reason: null,
      },
    ]),
    openAiChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    openAiChunk([], { prompt_tokens: 10, completion_tokens: 5 }),
    'data: [DONE]\n\n',
  ].join('')
}

function fakeFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(openAiStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
}

const ENV = {
  ONTOLOGY_COMPANY_MODEL_BASE_URL: 'https://company.example/v1',
  ONTOLOGY_COMPANY_MODEL_ENDPOINT: '/chat/completions',
  ONTOLOGY_COMPANY_MODEL_API_KEY: FAKE_COMPANY_KEY,
  ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS: `${VENDOR_MODEL}=company-llm`,
  ONTOLOGY_JEV_API_KEY: FAKE_JEV_KEY,
  ONTOLOGY_JEV_BASE_URL: '',
  ONTOLOGY_JEV_ENDPOINT: '',
}

describe('live model validation harness — deterministic OpenAI-compatible double', () => {
  it('validates the GenerationPort path and never records a secret value', async () => {
    const report = await runLiveValidation({
      env: ENV,
      secretsFile: 'D:/operator-only/live.env',
      modelMapRole: 'vendor-first',
      companyProtocol: 'openai-compatible',
      fetchImpl: fakeFetch(),
    })

    expect(report.company.map((call) => call.outcome)).toEqual(['validated', 'validated', 'validated'])
    expect(report.company[0]?.modelVersion ?? report.company[0]?.vendorModel).toBe(VENDOR_MODEL)
    const toolCall = report.company.find((call) => call.name === 'tool_call')
    expect(toolCall?.toolCalls?.[0]?.toolId).toBe('data_query')
    expect(toolCall?.toolCalls?.[0]?.argumentsJsonValid).toBe(true)
    // JEV has no base URL/endpoint configured: it must stay blocked, not faked.
    expect(report.jev.outcome).toBe('blocked')

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(FAKE_COMPANY_KEY)
    expect(serialized).not.toContain(FAKE_JEV_KEY)
    expect(report.summary.blocked).toBe(1)
  })
})
