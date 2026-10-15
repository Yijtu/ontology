import { sha256DigestOf } from '@ontology/core'
import { PublishedRelationNavigator } from '@ontology/semantic-engine'
import type { JobService } from '@ontology/application'
import { encodeDocumentIngestionRef, mapNativeEntities } from '@ontology/application'
import { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { FileSystemObjectStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { RelationNavigationError } from '@ontology/contracts'
import type { IdentityDecisionStore, RelationNavigationRequest, ScalarValue, ScopeRef, SemanticPublicationStore } from '@ontology/contracts'
import type { FastifyInstance } from 'fastify'
import type { LoadedCoreExamples } from '../composition/core-example-loader'
import { COMPONENT_VERSION, MAX_IMPORTED_BYTES } from '../composition/core-constants'
import { CoreCapabilityError } from '../composition/core-errors'
import { isRecord, sourceKey, stableUuid } from '../composition/core-composition-shared'
import { parseJsonRecordBlocks } from '../composition/core-json-records'
import { createRequestToolContext } from './context'
import { ForbiddenError, InvalidRequestFieldError } from './shared'
import type { RequestAuthenticator } from './shared'

/** Loopback host routes that are not model tools: raw document import and relation navigation. */

export function registerCoreImportRoute(input: {
  readonly app: FastifyInstance
  readonly authenticate: RequestAuthenticator
  readonly scopeRef: ScopeRef
  readonly examples: LoadedCoreExamples
  readonly service: JobService
  readonly objectStore: FileSystemObjectStore
  readonly registry: PostgresArtifactRegistry
  readonly generationEnabled: boolean
}): void {
  input.app.post('/api/v1/core/imports', async (request, reply) => {
    const auth = input.authenticate(request)
    if (auth === undefined) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'loopback development authentication is required', retryable: false } })
    if (!auth.principal.roles.includes('data-editor') && !auth.principal.roles.includes('platform-admin')) {
      throw new ForbiddenError('raw document import requires the explicit local operator role')
    }
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const scenarioId = request.body['scenarioId']
    const sourceId = request.body['sourceId']
    const content = request.body['content']
    if (typeof scenarioId !== 'string' || typeof sourceId !== 'string' || typeof content !== 'string') {
      throw new InvalidRequestFieldError('scenarioId, sourceId and content are required strings')
    }
    const scenario = input.examples.scenarios.find((entry) => entry.scenarioId === scenarioId)
    if (scenario === undefined) throw new InvalidRequestFieldError('scenarioId is not mounted by this deployment')
    const source = scenario.rawSources.find((entry) => entry.sourceRef.sourceId === sourceId)
    if (source === undefined) throw new InvalidRequestFieldError('sourceId is not a declared raw source for this scenario')
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_BYTES) {
      throw new InvalidRequestFieldError(`content must be between 1 byte and ${String(MAX_IMPORTED_BYTES)} bytes`)
    }
    let records: Record<string, ScalarValue>[]
    try {
      records = parseJsonRecordBlocks(content, 'import content')
    } catch {
      if (!input.generationEnabled) {
        throw new CoreCapabilityError('this local profile accepts native JSON records only; generative extraction is not configured')
      }
      records = []
    }
    const nativeRows = records.filter((record) => mapNativeEntities(scenario.industrySchema, record).length > 0)
    if ((records.length === 0 || nativeRows.length !== records.length) && !input.generationEnabled) {
      throw new CoreCapabilityError('this local profile accepts native JSON records only; generative extraction is not configured')
    }

    const requestId = request.headers['idempotency-key']
    const idempotencyKey = Array.isArray(requestId) ? requestId[0] : requestId
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 256) {
      throw new InvalidRequestFieldError('Idempotency-Key must be between 8 and 256 characters')
    }
    const rawKey = `${input.scopeRef.tenantId}:${input.scopeRef.spaceId}:${sourceKey(source.sourceRef)}:${sha256DigestOf(content)}:${idempotencyKey}`
    const jobId = globalThis.crypto.randomUUID()
    const ctx = createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId: request.id,
      runId: jobId,
    })
    const deterministicBlobs = new LocalImmutableBlobStore({
      objectStore: input.objectStore,
      registry: input.registry,
      idFactory: () => stableUuid(`import-blob:${rawKey}`),
    })
    const staged = await deterministicBlobs.stage(bytes, { scopeRef: input.scopeRef }, ctx)
    const original = await deterministicBlobs.publish({
      scopeRef: input.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: source.mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
      origin: { sourceRef: source.sourceRef, scenarioId, importKey: idempotencyKey },
    }, ctx)
    const documentVersionRef = {
      id: stableUuid(`document-version:${rawKey}`),
      version: COMPONENT_VERSION,
      digest: staged.contentDigest,
      kind: 'document' as const,
    }
    const documentRef = encodeDocumentIngestionRef({
      kind: 'document_ingestion',
      originalRef: original.blobRef,
      parserVersion: COMPONENT_VERSION,
      definitionRef: scenario.definitionRef,
      documentVersionRef,
    })
    const created = await input.service.createJob({
      jobId,
      kind: 'ingestion',
      sourceRef: `${source.sourceRef.namespace}/${source.sourceRef.sourceId}`,
      documentRef,
      pipelineVersion: COMPONENT_VERSION,
      idempotencyKey,
    }, ctx)
    return reply.status(202).send({
      data: { jobId: created.jobId, stage: created.stage, scenarioId, sourceRef: source.sourceRef },
      meta: { traceId: request.id, revision: created.revision },
    })
  })
}

export function readRelationNavigationRequest(value: unknown): RelationNavigationRequest | undefined {
  if (!isRecord(value)) return undefined
  const startEntityId = value['startEntityId']
  const validAt = value['validAt']
  const rawRelationIds = value['relationIds']
  const maxPaths = value['maxPaths']
  if (typeof startEntityId !== 'string' || typeof validAt !== 'string' || !Array.isArray(rawRelationIds)) {
    return undefined
  }
  const relationIds: string[] = []
  for (const relationId of rawRelationIds) {
    if (typeof relationId !== 'string') return undefined
    relationIds.push(relationId)
  }
  return {
    startEntityId,
    relationIds,
    validAt,
    ...(typeof maxPaths === 'number' ? { maxPaths } : {}),
  }
}

/**
 * Read-only loopback route for bounded published-relation navigation (V03-027 / #195,
 * A.US-008.AC-02, A.FR-14). It is not a model tool: the canonical catalogue is the closed set
 * of four model tools, so navigation is exposed to the host as an explicit service surface
 * instead of widening the model's tool authority. The route mints a trusted context from the
 * server-side authentication result and reads only the caller's scope.
 */
export function registerCoreRelationNavigationRoute(input: {
  readonly app: FastifyInstance
  readonly authenticate: RequestAuthenticator
  readonly examples: LoadedCoreExamples
  readonly publications: SemanticPublicationStore
  readonly identity: IdentityDecisionStore
}): void {
  input.app.post('/api/v1/core/relations/navigate', async (request, reply) => {
    const auth = input.authenticate(request)
    if (auth === undefined) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'loopback development authentication is required', retryable: false } })
    }
    const navigation = readRelationNavigationRequest(request.body)
    if (navigation === undefined) {
      throw new InvalidRequestFieldError('startEntityId, validAt and a relationIds array of strings are required')
    }
    const scenarioId = isRecord(request.body) ? request.body['scenarioId'] : undefined
    if (typeof scenarioId !== 'string') throw new InvalidRequestFieldError('scenarioId is required')
    const scenario = input.examples.scenarios.find((entry) => entry.scenarioId === scenarioId)
    if (scenario === undefined) throw new InvalidRequestFieldError('scenarioId is not mounted by this deployment')
    const navigator = new PublishedRelationNavigator({
      publications: input.publications,
      identity: input.identity,
      definitionRef: scenario.definitionRef,
      allowedRelationIds: scenario.industrySchema.relations.map((relation) => relation.relationId),
      relationTargets: new Map(
        scenario.industrySchema.relations.map((relation) => [
          relation.relationId,
          { fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId },
        ]),
      ),
    })
    const ctx = createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId: request.id,
      runId: globalThis.crypto.randomUUID(),
    })
    try {
      const result = await navigator.navigate(navigation, ctx)
      return reply.status(200).send({ data: result, meta: { traceId: request.id } })
    } catch (error) {
      if (error instanceof RelationNavigationError) {
        if (error.code === 'FORBIDDEN') throw new ForbiddenError(error.message)
        throw new InvalidRequestFieldError(error.message)
      }
      throw error
    }
  })
}
