import { describe, expect, it } from 'vitest'
import { parseSemanticTaskIntent, SemanticTaskIntentPlanner } from '@ontology/application'
import type { GenerationEvent, GenerationPort, GenerationRequest } from '@ontology/contracts'
import { createToolContext } from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

function context() { return createToolContext({ ...toolContext(), deadline: new Date(Date.now() + 60_000).toISOString() }) }
const model = { modelId: 'controlled-semantic-selector', version: '1.0.0' }
const catalog = { tasks: [{ kind: 'rule_judgement' }], entities: [{ object: 'facility', labels: ['T-01'] }], rules: [{ name: 'Inspection policy', object: 'facility' }] }
function generator(events: readonly GenerationEvent[], capture?: (request: GenerationRequest) => void): GenerationPort {
  return { async *generate(request) { capture?.(request); for (const event of events) yield event } }
}

describe('finite semantic intent boundary (#265)', () => {
  it('accepts the five semantic intent families while refusing refs, functions, authority and invalid bounds', () => {
    for (const intent of [
      { kind: 'structured_query', object: 'facility', fields: ['name'] },
      { kind: 'rule_judgement', rule: 'Inspection policy', entity: 'T-01' },
      { kind: 'relations', entity: 'T-01', relations: ['located_in'] },
      { kind: 'document_qa', query: 'inspection exemption' },
      { kind: 'compute', operation: 'approved.task.aggregate', parameters: {} },
    ]) expect(parseSemanticTaskIntent(intent)).toEqual(intent)
    for (const intent of [
      { kind: 'rule_judgement', rule: 'policy', entity: 'T-01', ruleRef: { id: 'guessed' } },
      { kind: 'relations', entity: 'T-01', relations: ['a', 'b', 'c', 'd'] },
      { kind: 'structured_query', object: 'facility', fields: ['name'], limit: 1001 },
      { kind: 'compute', operation: 'aggregate', parameters: {}, handler: 'arbitrary' },
      { kind: 'function', name: 'eval' },
    ]) expect(parseSemanticTaskIntent(intent)).toBeUndefined()
  })

  it('makes one proposal without model tools and refuses malformed, truncated, multiple or tool output', async () => {
    const selected = { kind: 'rule_judgement', rule: 'Inspection policy', entity: 'T-01' }
    let request: GenerationRequest | undefined
    expect(await new SemanticTaskIntentPlanner(generator([{ type: 'text_delta', text: JSON.stringify(selected) }, { type: 'completed', stopReason: 'stop', candidateOnly: true }], (value) => { request = value }), model).propose({ question: 'Inspect T-01', catalog }, context())).toEqual(selected)
    expect(request?.toolSchemas).toEqual([])
    expect(request?.messages[1]?.content).toContain('Inspection policy')
    for (const events of [
      [{ type: 'text_delta', text: JSON.stringify(selected) }],
      [{ type: 'text_delta', text: JSON.stringify(selected) }, { type: 'completed', stopReason: 'length', candidateOnly: true }],
      [{ type: 'text_delta', text: JSON.stringify(selected) }, { type: 'completed', stopReason: 'stop', candidateOnly: true }, { type: 'text_delta', text: 'late' }],
      [{ type: 'tool_call_delta', callId: 'not-authority', toolId: 'ontology_lookup', argumentsDelta: '{}' }],
    ] satisfies GenerationEvent[][]) await expect(new SemanticTaskIntentPlanner(generator(events), model).propose({ question: 'Inspect T-01', catalog }, context())).rejects.toThrow()
  })

  it('shares cancellation and refuses oversized output rather than executing a late selection', async () => {
    const abort = new AbortController()
    const port: GenerationPort = { async *generate() { yield { type: 'text_delta', text: '{"kind":"clarify","reason":"choose"}' }; abort.abort(); yield { type: 'completed', stopReason: 'stop', candidateOnly: true } } }
    await expect(new SemanticTaskIntentPlanner(port, model).propose({ question: 'Inspect', catalog }, context(), abort.signal)).rejects.toThrow()
    await expect(new SemanticTaskIntentPlanner(generator([{ type: 'text_delta', text: 'x'.repeat(65_537) }]), model).propose({ question: 'Inspect', catalog }, context())).rejects.toThrow('bound')
  })
})
