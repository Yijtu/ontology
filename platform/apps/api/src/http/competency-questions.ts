import type { FastifyInstance } from 'fastify'
import { CompetencyQuestionError, isVersionRef } from '@ontology/contracts'
import type { CompetencyQuestionService } from '@ontology/application'
import type { ToolContext, VersionRef } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, isRecord, readTraceId, ForbiddenError, InvalidRequestFieldError } from './shared'
import type { RequestAuthenticator } from './shared'

export interface CompetencyQuestionRouteDependencies {
  readonly uploadSource?: (bytes: Uint8Array, mediaType: string, ctx: ToolContext) => Promise<VersionRef>
  readonly service: CompetencyQuestionService
  readonly authenticate: RequestAuthenticator
}

/** The upload creates an immutable review candidate; approval stays on /candidates/:id/reviews. */
export function registerCompetencyQuestionRoutes(app: FastifyInstance, dependencies: CompetencyQuestionRouteDependencies): void {
  if (dependencies.uploadSource !== undefined) {
    if (!app.hasContentTypeParser('application/octet-stream')) app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => { done(null, body) })
    app.post('/api/v1/competency-question-sources', { bodyLimit: 8_388_608 }, async (request, reply) => {
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const mediaType = request.headers['x-source-media-type']
      if (!(request.body instanceof Uint8Array) || typeof mediaType !== 'string') throw new InvalidRequestFieldError('competency source requires raw bytes and an explicit source media type')
      const traceId = readTraceId(request)
      const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID() })
      const sourceRef = await dependencies.uploadSource!(request.body, mediaType, ctx)
      reply.status(201).send({ data: { sourceRef }, meta: { traceId } })
      return reply
    })
  }
  app.post('/api/v1/competency-question-sets', async (request, reply) => {
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    if (!auth.principal.roles.some((role) => role === 'platform-admin' || role === 'profile-editor')) throw new ForbiddenError('competency upload requires an editor role')
    const traceId = readTraceId(request)
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID() })
    const declaration = await dependencies.service.upload(request.body, ctx)
    reply.status(201).send({ data: { declaration, candidateId: declaration.ref.id, approvalRequired: true }, meta: { traceId } })
    return reply
  })
  app.post('/api/v1/competency-question-sets/read', async (request, reply) => {
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const body = request.body
    if (!isRecord(body) || Object.keys(body).some((key) => key !== 'ref') || !isVersionRef(body['ref'])) throw new InvalidRequestFieldError('competency read requires one exact ref')
    const traceId = readTraceId(request)
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID() })
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const content = await dependencies.service.readBody(scope, body['ref'], ctx)
    if (content === undefined) throw new CompetencyQuestionError('UNKNOWN_PIN', 'competency declaration is not visible at this exact version')
    const approved = await dependencies.service.readApproved(scope, body['ref'], ctx)
    reply.status(200).send({ data: { declaration: { ref: body['ref'], body: content }, approved: approved !== undefined }, meta: { traceId } })
    return reply
  })
}
