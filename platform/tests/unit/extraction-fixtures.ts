import { randomUUID } from 'node:crypto'
import type {
  CandidateSourceSpan,
  CandidateStateTransition,
  CandidateStore,
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentParseStore,
  GenerationEvent,
  GenerationRequest,
  GenerationUsage,
  IndustrySchema,
  RecordDocumentParseResult,
  ScopeRef,
  TextCandidateSourceSpan,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { CandidateStoreError } from '@ontology/contracts'
import type { GenerationPort } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/application'

/** Narrow a candidate source span to its text/PDF chunk form, or `undefined` for a row span. */
export function textSpan(span: CandidateSourceSpan | undefined): TextCandidateSourceSpan | undefined {
  return span !== undefined && span.kind !== 'structured' ? span : undefined
}

export const PARSE_ID = '99999999-9999-4999-8999-999999999999'
export const JOB_ID = '88888888-8888-4888-8888-888888888888'
export const LEDGER_ID = '77777777-7777-4777-8777-777777777777'
export const PARSER_VERSION = '1.0.0'

export const DEFINITION_REF: VersionRef = {
  id: 'home-energy.core',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

export const MODEL_REF = { modelId: 'deterministic-test-model', version: '1.0.0' } as const

/** An industry schema projection equivalent to a published home-energy core definition. */
export function buildIndustrySchema(definitionRef: VersionRef = DEFINITION_REF): IndustrySchema {
  return {
    namespace: 'home-energy',
    definitionRef,
    objects: [
      {
        objectId: 'device',
        displayName: 'Device',
        identityScopeId: 'device_identity',
        attributes: [
          {
            attributeId: 'device_native_id',
            valueType: 'string',
            minCardinality: 1,
            maxCardinality: 1,
            identityKey: true,
          },
          {
            attributeId: 'device_name',
            valueType: 'string',
            minCardinality: 0,
            maxCardinality: 1,
            identityKey: false,
          },
          {
            attributeId: 'rated_power',
            valueType: 'quantity',
            minCardinality: 0,
            maxCardinality: 1,
            identityKey: false,
            unitCode: 'kW',
            dimension: 'power',
          },
          {
            attributeId: 'device_kind',
            valueType: 'enum',
            minCardinality: 1,
            maxCardinality: 1,
            identityKey: false,
            enumValues: ['charger', 'inverter'],
          },
        ],
      },
      {
        objectId: 'meter',
        displayName: 'Meter',
        identityScopeId: 'meter_identity',
        attributes: [
          {
            attributeId: 'meter_native_id',
            valueType: 'string',
            minCardinality: 1,
            maxCardinality: 1,
            identityKey: true,
          },
        ],
      },
    ],
    relations: [
      {
        relationId: 'meter_monitors_device',
        fromObjectId: 'meter',
        toObjectId: 'device',
        minCardinality: 0,
        maxCardinality: 'unbounded',
      },
    ],
    identityScopes: [
      {
        identityScopeId: 'device_identity',
        objectId: 'device',
        scopeDimensions: ['source', 'site', 'device_type'],
        identityAttributeIds: ['device_native_id'],
      },
      {
        identityScopeId: 'meter_identity',
        objectId: 'meter',
        scopeDimensions: ['source', 'site'],
        identityAttributeIds: ['meter_native_id'],
      },
    ],
  }
}

export function chunkOf(
  text: string,
  ordinal: number,
  chunkId: Uuid = randomUUID(),
): DocumentChunkRecord {
  return {
    chunkId,
    ordinal,
    chunkKind: 'paragraph',
    text,
    textDigest: sha256DigestOf(text),
    locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: sha256DigestOf(`quote:${text}`),
    conditions: [],
    exceptions: [],
  }
}

export type ScriptedGeneration =
  | { readonly events: readonly GenerationEvent[] }
  | { readonly error: Error }

/** A deterministic `GenerationPort` double. It never contacts a real or paid model. */
export class CountingGenerationPort implements GenerationPort {
  readonly requests: GenerationRequest[] = []
  readonly #queue: ScriptedGeneration[] = []
  readonly #fallback: ScriptedGeneration | undefined

  constructor(fallback?: ScriptedGeneration) {
    this.#fallback = fallback
  }

  enqueue(response: ScriptedGeneration): void {
    this.#queue.push(response)
  }

  get callCount(): number {
    return this.requests.length
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    this.requests.push(request)
    const next = this.#queue.shift() ?? this.#fallback
    if (next === undefined) {
      throw new Error('no scripted generation response is queued')
    }
    if ('error' in next) throw next.error
    for (const event of next.events) yield event
  }
}

export function generationResponse(
  payload: unknown,
  usage: GenerationUsage = { inputTokens: 12, outputTokens: 7 },
): ScriptedGeneration {
  return {
    events: [
      { type: 'text_delta', text: JSON.stringify(payload) },
      { type: 'usage', usage },
      { type: 'completed', stopReason: 'stop', candidateOnly: true },
    ],
  }
}

/**
 * Minimal `DocumentParseStore` that returns a fixed chunk set. The real store is used in the
 * integration test; this only supplies chunks to the unit-level job stages.
 */
export class StaticDocumentParseStore implements DocumentParseStore {
  readonly #chunks: readonly DocumentChunkRecord[]

  constructor(chunks: readonly DocumentChunkRecord[]) {
    this.#chunks = chunks
  }

  async recordParse(): Promise<RecordDocumentParseResult> {
    return { created: false }
  }

  async findParseByDigest(): Promise<DocumentParseRecord | undefined> {
    return undefined
  }

  async listChunks(): Promise<DocumentChunkRecord[]> {
    return this.#chunks.map((chunk) => ({ ...chunk }))
  }

  async listChunksByScope(): Promise<DocumentChunkRecord[]> {
    return this.#chunks.map((chunk) => ({ ...chunk }))
  }

  async close(): Promise<void> {
    return undefined
  }
}

/** Wraps a candidate store and fails the next state transition once, to test stage retry. */
export class FaultInjectingCandidateStore implements CandidateStore {
  readonly #delegate: CandidateStore
  #failNextTransition = false

  constructor(delegate: CandidateStore) {
    this.#delegate = delegate
  }

  armTransitionFailure(): void {
    this.#failNextTransition = true
  }

  insertCandidates(
    scopeRef: ScopeRef,
    candidates: Parameters<CandidateStore['insertCandidates']>[1],
    ctx: ToolContext,
  ): ReturnType<CandidateStore['insertCandidates']> {
    return this.#delegate.insertCandidates(scopeRef, candidates, ctx)
  }

  getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): ReturnType<CandidateStore['getCandidate']> {
    return this.#delegate.getCandidate(scopeRef, candidateId, ctx)
  }

  listCandidates(
    scopeRef: ScopeRef,
    query: Parameters<CandidateStore['listCandidates']>[1],
    ctx: ToolContext,
  ): ReturnType<CandidateStore['listCandidates']> {
    return this.#delegate.listCandidates(scopeRef, query, ctx)
  }

  async transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: CandidateStateTransition,
    ctx: ToolContext,
  ): ReturnType<CandidateStore['transitionCandidate']> {
    if (this.#failNextTransition) {
      this.#failNextTransition = false
      throw new CandidateStoreError('CANDIDATE_STORE_FAILED', 'injected transition failure')
    }
    return this.#delegate.transitionCandidate(scopeRef, candidateId, transition, ctx)
  }

  countCandidates(
    scopeRef: ScopeRef,
    jobId: Uuid,
    ctx: ToolContext,
  ): ReturnType<CandidateStore['countCandidates']> {
    return this.#delegate.countCandidates(scopeRef, jobId, ctx)
  }
}
