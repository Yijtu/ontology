import type {
  DocumentSearchPort,
  DocumentSearchRequest,
  DocumentSearchResponse,
  EntityCandidate,
  ReadSpanRequest,
  ReadSpanResponse,
  SourceSnapshot,
  VersionRef,
} from '@ontology/contracts'
import type {
  IdentityIndexEntry,
  SimilarityBackend,
  SimilarityComparison,
  SimilarityComparisonRequest,
} from '@ontology/semantic-engine'

export const IDENTITY_DEFINITION_REF: VersionRef = {
  id: 'home-energy.core',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

export const IDENTITY_DIMENSIONS = {
  source: 'docs',
  site: 'site-a',
  device_type: 'charger',
} as const

export function identitySnapshot(): SourceSnapshot {
  return {
    sourceRef: { namespace: 'ontology.identity_index', sourceId: 'fixture' },
    schemaVersion: '1.0.0',
    readAt: '2026-09-22T00:00:00Z',
    consistency: 'immutable',
    resultDigest: `sha256:${'e'.repeat(64)}`,
  }
}

export function indexEntry(overrides: Partial<IdentityIndexEntry> & { readonly entityId: string }): IdentityIndexEntry {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    objectId: 'device',
    identityScopeId: 'device_identity',
    entityType: 'device',
    displayName: 'Device',
    normalizedName: 'device',
    aliasConfirmed: false,
    dimensions: { ...IDENTITY_DIMENSIONS },
    ...overrides,
  }
}

export function sourceSpan(): EntityCandidate['sourceSpans'][number] {
  return {
    parseId: '99999999-9999-4999-8999-999999999999',
    chunkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    locator: { kind: 'offset', startOffset: 0, endOffset: 11 },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: `sha256:${'6'.repeat(64)}`,
    textDigest: `sha256:${'7'.repeat(64)}`,
  }
}

export function entityCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  return {
    kind: 'entity',
    candidateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    jobId: '88888888-8888-4888-8888-888888888888',
    objectId: 'device',
    identityScopeId: 'device_identity',
    attributes: [
      { attributeId: 'device_native_id', value: 'DEV-1' },
      { attributeId: 'device_name', value: 'Charger One' },
    ],
    sourceSpans: [sourceSpan()],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: IDENTITY_DEFINITION_REF,
      parseId: '99999999-9999-4999-8999-999999999999',
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    idempotencyKey: `sha256:${'f'.repeat(64)}`,
    recordedAt: '2026-09-22T00:00:00Z',
    ...overrides,
  }
}

/** A deterministic `DocumentSearchPort` double. It never touches a real index. */
export class FakeDocumentSearchPort implements DocumentSearchPort {
  readonly requests: DocumentSearchRequest[] = []
  #spans: DocumentSearchResponse['spans'] = []

  setSpans(spans: DocumentSearchResponse['spans']): void {
    this.#spans = spans
  }

  async search(request: DocumentSearchRequest): Promise<DocumentSearchResponse> {
    this.requests.push(request)
    return {
      spans: [...this.#spans],
      scoreKind: 'bm25',
      indexVersion: { indexRef: { id: 'fixture', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` }, generation: '1', builtAt: '2026-09-22T00:00:00Z' },
      completeness: 'complete',
      snapshot: identitySnapshot(),
      nextCursor: null,
    }
  }

  async readSpan(request: ReadSpanRequest): Promise<ReadSpanResponse> {
    return {
      documentRef: request.documentRef,
      text: 'fixture',
      textDigest: `sha256:${'2'.repeat(64)}`,
      snapshot: identitySnapshot(),
    }
  }
}

/**
 * A counting similarity double. It records how many bounded comparison calls were made
 * and how many candidate pairs were sent, so a test can prove the recall never performs a
 * full-corpus pairwise comparison. It makes no model call.
 */
export class CountingSimilarityBackend implements SimilarityBackend {
  readonly backendRef: VersionRef = { id: 'fixture.similarity', version: '1.0.0', digest: `sha256:${'3'.repeat(64)}` }
  readonly requests: SimilarityComparisonRequest[] = []
  pairCount = 0
  #scores = new Map<string, number>()

  setScore(entityId: string, score: number): void {
    this.#scores.set(entityId, score)
  }

  get calls(): number {
    return this.requests.length
  }

  async compare(request: SimilarityComparisonRequest): Promise<SimilarityComparison> {
    this.requests.push(request)
    this.pairCount += request.candidates.length
    return {
      scores: request.candidates.map((candidate) => ({
        entityId: candidate.entityId,
        score: this.#scores.get(candidate.entityId) ?? 0.5,
      })),
      backendRef: this.backendRef,
      modelRef: { modelId: 'fixture-similarity', version: '1.0.0' },
      usage: { inputTokens: 11, outputTokens: 5 },
    }
  }
}
