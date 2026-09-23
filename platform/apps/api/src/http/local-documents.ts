import type { FastifyInstance } from 'fastify'
import type { ToolContext } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, isRecord, readTraceId } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'
import { LocalDocumentCapability, MAX_LOCAL_DOCUMENT_BYTES } from '../composition/local-documents'

export function registerLocalDocumentImportRoute(app: FastifyInstance, dependencies: {
  readonly authenticate: RequestAuthenticator
  readonly documents: LocalDocumentCapability
}): void {
  app.post('/api/v1/operator/documents', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    if (!auth.principal.roles.includes('data-editor') && !auth.principal.roles.includes('platform-admin')) {
      throw new ForbiddenError('document import requires the data-editor role')
    }
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request must be a JSON object')
    const title = body['title']
    const content = body['content']
    const mediaType = body['mediaType']
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) throw new InvalidRequestFieldError('title must contain 1–200 characters')
    if (typeof content !== 'string') throw new InvalidRequestFieldError('content must be a UTF-8 string')
    if (mediaType !== undefined && mediaType !== 'text/markdown' && mediaType !== 'text/plain') throw new InvalidRequestFieldError('only Markdown and plain text are accepted by this operator import route')
    if (new TextEncoder().encode(content).byteLength > MAX_LOCAL_DOCUMENT_BYTES) throw new InvalidRequestFieldError(`content exceeds ${String(MAX_LOCAL_DOCUMENT_BYTES)} UTF-8 bytes`)
    const context = contextFor(auth, traceId)
    const result = await dependencies.documents.importMarkdown({ title: title.trim(), content, mediaType: mediaType === 'text/plain' ? 'text/plain' : 'text/markdown' }, context)
    reply.status(201).send({ data: { ...result, title: title.trim(), importedBy: auth.principal.subjectId }, meta: { traceId } })
    return reply
  })
}

function contextFor(auth: AuthenticatedRequest, traceId: string): ToolContext {
  return createRequestToolContext({
    principal: auth.principal,
    spaceId: auth.spaceId,
    runId: globalThis.crypto.randomUUID(),
    traceId,
    ...(auth.allowedDomains === undefined ? {} : { allowedDomains: auth.allowedDomains }),
    ...(auth.allowedResourceKinds === undefined ? {} : { allowedResourceKinds: auth.allowedResourceKinds }),
    ...(auth.allowedSourceRefs === undefined ? {} : { allowedSourceRefs: auth.allowedSourceRefs }),
    ...(auth.allowedCollectionRefs === undefined ? {} : { allowedCollectionRefs: auth.allowedCollectionRefs }),
    ...(auth.maxRows === undefined ? {} : { maxRows: auth.maxRows }),
  })
}
