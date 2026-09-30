import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  IndustryAssetPublicationService,
  IndustryPackExportService,
  IndustryPackUpgradeService,
} from '@ontology/application'
import { summarizePackCatalogEntry } from '@ontology/application'
import type {
  ComponentKey,
  ComponentKind,
  IndustryPackCatalogue,
  LogicalRole,
  MappingRef,
  ProfileRef,
  ToolContext,
  UpgradeRequest,
  UpgradeSlot,
  VersionRef,
} from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { failureBody } from './errors'
import { ForbiddenError, InvalidRequestFieldError } from './shared'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readRevisionHeader,
  readTraceId,
  requireNonEmptyString,
  scopeRefFor,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const PROFILE_EDITOR_ROLES: readonly string[] = ['platform-admin', 'profile-editor']
const LOGICAL_ROLES: readonly LogicalRole[] = ['telemetry', 'catalog', 'documents']
const COMPONENT_KINDS: readonly ComponentKind[] = [
  'runtime',
  'generation',
  'decision',
  'data_backend',
  'document_backend',
  'blob_backend',
  'compute_extension',
  'industry_pack',
  'transport',
  'control_store',
]

/**
 * Industry-pack export and compatibility-upgrade surface (SPEC C1/C6, US-023).
 *
 * The tenant/space scope always comes from the trusted principal. A blocked upgrade is a
 * 409 with the explicit blockers (each carrying `recoverable` and `nextAction`); it is never
 * a silent success. The maturity-gated list is what the UI/API reports as usable, so a
 * `planned`/`preview` preparation pack can never be presented as validated.
 */
export interface PackRouteDependencies {
  readonly catalogue: IndustryPackCatalogue
  readonly packExports: IndustryPackExportService
  readonly packUpgrades: IndustryPackUpgradeService
  /**
   * V03-015: publish a human-reviewed draft as an immutable, versioned pack. Optional so the
   * read-only export/upgrade surface keeps working in a deployment that does not enable publishing.
   */
  readonly publication?: IndustryAssetPublicationService
}

function readIfMatch(request: FastifyRequest): string | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
  }
  return header.value
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined || key.length < 8) {
    throw new InvalidRequestFieldError('an Idempotency-Key header (>= 8 chars) is required')
  }
  return key
}

export interface PackApiOptions extends PackRouteDependencies {
  readonly authenticate: RequestAuthenticator
}

function requireRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new ForbiddenError(`${action} requires one of the roles: ${roles.join(', ')}`)
  }
}

function versionRefOf(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  return {
    id: requireNonEmptyString(value['id'], `${field}.id`),
    version: requireNonEmptyString(value['version'], `${field}.version`),
    digest: requireNonEmptyString(value['digest'], `${field}.digest`),
  }
}

function profileRefOf(value: unknown, field: string): ProfileRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  return {
    id: requireNonEmptyString(value['id'], `${field}.id`),
    version: requireNonEmptyString(value['version'], `${field}.version`),
  }
}

function logicalRoleOf(value: unknown, field: string): LogicalRole {
  const role = requireNonEmptyString(value, field)
  const match = LOGICAL_ROLES.find((candidate) => candidate === role)
  if (match === undefined) {
    throw new InvalidRequestFieldError(`${field} must be one of: ${LOGICAL_ROLES.join(', ')}`)
  }
  return match
}

function componentKindOf(value: unknown, field: string): ComponentKind {
  const kind = requireNonEmptyString(value, field)
  const match = COMPONENT_KINDS.find((candidate) => candidate === kind)
  if (match === undefined) {
    throw new InvalidRequestFieldError(`${field} must be one of: ${COMPONENT_KINDS.join(', ')}`)
  }
  return match
}

function mappingRefOf(value: unknown, field: string): MappingRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  const sourceObjectRef = value['sourceObjectRef']
  if (!isRecord(sourceObjectRef)) {
    throw new InvalidRequestFieldError(`${field}.sourceObjectRef must be an object`)
  }
  const sourceRef = sourceObjectRef['sourceRef']
  if (!isRecord(sourceRef)) {
    throw new InvalidRequestFieldError(`${field}.sourceObjectRef.sourceRef must be an object`)
  }
  return {
    id: requireNonEmptyString(value['id'], `${field}.id`),
    version: requireNonEmptyString(value['version'], `${field}.version`),
    digest: requireNonEmptyString(value['digest'], `${field}.digest`),
    role: logicalRoleOf(value['role'], `${field}.role`),
    sourceObjectRef: {
      sourceRef: {
        namespace: requireNonEmptyString(sourceRef['namespace'], `${field}.sourceObjectRef.sourceRef.namespace`),
        sourceId: requireNonEmptyString(sourceRef['sourceId'], `${field}.sourceObjectRef.sourceRef.sourceId`),
      },
      objectPath: requireNonEmptyString(sourceObjectRef['objectPath'], `${field}.sourceObjectRef.objectPath`),
    },
  }
}

function upgradeSlotOf(value: unknown): UpgradeSlot {
  if (!isRecord(value)) throw new InvalidRequestFieldError('slot must be an object')
  const kind = requireNonEmptyString(value['kind'], 'slot.kind')
  switch (kind) {
    case 'industry':
    case 'runtime':
    case 'policy':
      return { kind }
    case 'backend_binding':
      return { kind, role: logicalRoleOf(value['role'], 'slot.role') }
    case 'mapping':
      return { kind, mappingId: requireNonEmptyString(value['mappingId'], 'slot.mappingId') }
    default:
      throw new InvalidRequestFieldError(
        'slot.kind must be one of: industry, runtime, policy, backend_binding, mapping',
      )
  }
}

export function registerPackRoutes(
  app: FastifyInstance,
  dependencies: PackRouteDependencies & { readonly authenticate: RequestAuthenticator },
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string): ToolContext =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: globalThis.crypto.randomUUID(),
    })

  app.get('/api/v1/industry-packs', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const scopeRef = scopeRefFor(auth)
    const ctx = contextFor(auth, traceId)
    requireRole(ctx, PROFILE_EDITOR_ROLES, 'listing industry packs')

    const entries = await dependencies.catalogue.listEntries(scopeRef, ctx)
    const packs = entries.map((entry) => summarizePackCatalogEntry(entry))
    reply.status(200).send({ data: { packs }, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { packId: string } }>(
    '/api/v1/industry-packs/:packId/export',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, PROFILE_EDITOR_ROLES, 'exporting an industry pack')

      const query = isRecord(request.query) ? request.query : {}
      const version = requireNonEmptyString(query['version'], 'version')
      const bundle = await dependencies.packExports.export(
        { scopeRef, packId: requireNonEmptyString(request.params.packId, 'packId'), version },
        ctx,
      )
      reply.status(200).send({ data: bundle, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { packId: string } }>(
    '/api/v1/industry-packs/:packId/upgrade',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, PROFILE_EDITOR_ROLES, 'upgrading an industry pack binding')

      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const targetMappingRef = body['targetMappingRef']
      const upgrade: UpgradeRequest = {
        scopeRef,
        packId: requireNonEmptyString(request.params.packId, 'packId'),
        sourceProfileRef: profileRefOf(body['sourceProfileRef'], 'sourceProfileRef'),
        targetProfileRef: profileRefOf(body['targetProfileRef'], 'targetProfileRef'),
        slot: upgradeSlotOf(body['slot']),
        targetRef: versionRefOf(body['targetRef'], 'targetRef'),
        ...(targetMappingRef === undefined
          ? {}
          : { targetMappingRef: mappingRefOf(targetMappingRef, 'targetMappingRef') }),
      }

      const outcome = await dependencies.packUpgrades.applyUpgrade(upgrade, ctx)
      if (outcome.status === 'blocked') {
        reply.status(409).send(
          failureBody(
            {
              code: 'PROFILE_INCOMPATIBLE',
              httpStatus: 409,
              message: `the upgrade of ${upgrade.sourceProfileRef.id}@${upgrade.sourceProfileRef.version} is blocked`,
              reasons: outcome.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
            },
            traceId,
          ),
        )
        return reply
      }
      reply.status(200).send({ data: outcome, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { packId: string } }>(
    '/api/v1/industry-packs/:packId/retire',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, ['platform-admin'], 'retiring a component version')

      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const component = body['component']
      if (!isRecord(component)) {
        throw new InvalidRequestFieldError('component must be an object')
      }
      const key: ComponentKey = {
        kind: componentKindOf(component['kind'], 'component.kind'),
        id: requireNonEmptyString(component['id'], 'component.id'),
        version: requireNonEmptyString(component['version'], 'component.version'),
      }
      const retired = await dependencies.packUpgrades.retire(key, scopeRef, ctx)
      reply.status(200).send({ data: retired, meta: { traceId } })
      return reply
    },
  )

  if (dependencies.publication !== undefined) {
    const publication = dependencies.publication
    app.post<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/publications',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const ctx = contextFor(auth, traceId)
        requireRole(ctx, PROFILE_EDITOR_ROLES, 'publishing an industry pack')

        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const asset = await publication.publish(
          request.params.workspaceId,
          {
            packId: requireNonEmptyString(body['packId'], 'packId'),
            version: requireNonEmptyString(body['version'], 'version'),
            validationId: requireNonEmptyString(body['validationId'], 'validationId'),
            expectedRevision: readIfMatch(request),
            idempotencyKey: requireIdempotencyKey(request),
            requireDeploymentExecutable: body['requireDeploymentExecutable'] === true,
          },
          auth.principal.subjectId,
          ctx,
        )
        reply.status(201).send({
          data: { pack: asset, packRef: asset.packRef, capabilityStatus: asset.capabilities },
          meta: { traceId },
        })
        return reply
      },
    )
  }
}
