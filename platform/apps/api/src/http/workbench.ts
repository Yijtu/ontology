import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { ProfileResolver, SourceRegistry } from '@ontology/application'
import type {
  ActiveProfileRecord,
  CapabilityRequirement,
  ComponentKind,
  ComponentListFilter,
  ComponentRegistryStore,
  ComponentVersionRecord,
  ContractRange,
  DeploymentEnvironment,
  LogicalRole,
  MappingRef,
  ModuleLifecycleState,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  ProfileVersionRecord,
  RevisionString,
  SourceBindingRecord,
  SourceProbeJobRecord,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { createRequestToolContext } from './context'
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
const DATA_EDITOR_ROLES: readonly string[] = ['platform-admin', 'data-editor']
const ENVIRONMENTS: readonly DeploymentEnvironment[] = ['local_dev', 'ci', 'staging', 'production']
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
const LIFECYCLE_STATES: readonly ModuleLifecycleState[] = [
  'registered',
  'validated',
  'active',
  'deprecated',
  'retired',
]

/**
 * The configuration workbench surface (SPEC C6, §3): registered components, profile
 * publish/preflight/activate and source registration/probing.
 *
 * Two invariants are enforced at this edge:
 *
 * 1. The tenant/space scope always comes from the trusted principal, never the body, so a
 *    request cannot act on another tenant by editing JSON (INV-07).
 * 2. Activation is not a plain write. It first asks the source registry whether the
 *    resolved preflight is still fresh against its source bindings, then performs the
 *    compare-and-set. A mapping/capability version change therefore forces a re-preflight
 *    instead of silently activating a manifest whose inputs moved (the LOCAL-008 wiring).
 */
export interface WorkbenchRouteDependencies {
  readonly profiles: ProfileResolver
  readonly sources: SourceRegistry
  readonly components: ComponentRegistryStore
}

export interface WorkbenchApiOptions extends WorkbenchRouteDependencies {
  readonly authenticate: RequestAuthenticator
}

function requireRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new ForbiddenError(`${action} requires one of the roles: ${roles.join(', ')}`)
  }
}

/**
 * A create endpoint is not safe to retry blindly, so it requires an explicit
 * `Idempotency-Key` (C6). It is a per-route hook, not a global one: the run surface has its
 * own idempotency rules and must not be re-scoped by the workbench.
 */
const requireIdempotencyKey: preHandlerHookHandler = (request, _reply, done) => {
  if (readHeader(request, 'idempotency-key') === undefined) {
    done(new InvalidRequestFieldError('the Idempotency-Key header is required'))
    return
  }
  done()
}

function environmentOf(value: unknown): DeploymentEnvironment {
  const environment = requireNonEmptyString(value, 'environment')
  const match = ENVIRONMENTS.find((candidate) => candidate === environment)
  if (match === undefined) {
    throw new InvalidRequestFieldError(`environment must be one of: ${ENVIRONMENTS.join(', ')}`)
  }
  return match
}

function logicalRoleOf(value: unknown, field: string): LogicalRole {
  const role = requireNonEmptyString(value, field)
  if (role !== 'telemetry' && role !== 'catalog' && role !== 'documents') {
    throw new InvalidRequestFieldError(`${field} must be one of: telemetry, catalog, documents`)
  }
  return role
}

function versionRefOf(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  return {
    id: requireNonEmptyString(value['id'], `${field}.id`),
    version: requireNonEmptyString(value['version'], `${field}.version`),
    digest: requireNonEmptyString(value['digest'], `${field}.digest`),
  }
}

function contractRangeOf(value: unknown, field: string): ContractRange {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  const max = value['max']
  return {
    min: requireNonEmptyString(value['min'], `${field}.min`),
    ...(max === undefined ? {} : { max: requireNonEmptyString(max, `${field}.max`) }),
  }
}

function mappingRefOf(value: unknown): MappingRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError('mappingRef must be an object')
  const sourceObjectRef = value['sourceObjectRef']
  if (!isRecord(sourceObjectRef)) {
    throw new InvalidRequestFieldError('mappingRef.sourceObjectRef must be an object')
  }
  const sourceRef = sourceObjectRef['sourceRef']
  if (!isRecord(sourceRef)) {
    throw new InvalidRequestFieldError('mappingRef.sourceObjectRef.sourceRef must be an object')
  }
  const unitConversionsRef = value['unitConversionsRef']
  const schemaRevision = value['schemaRevision']
  return {
    id: requireNonEmptyString(value['id'], 'mappingRef.id'),
    version: requireNonEmptyString(value['version'], 'mappingRef.version'),
    digest: requireNonEmptyString(value['digest'], 'mappingRef.digest'),
    role: logicalRoleOf(value['role'], 'mappingRef.role'),
    sourceObjectRef: {
      sourceRef: {
        namespace: requireNonEmptyString(
          sourceRef['namespace'],
          'mappingRef.sourceObjectRef.sourceRef.namespace',
        ),
        sourceId: requireNonEmptyString(
          sourceRef['sourceId'],
          'mappingRef.sourceObjectRef.sourceRef.sourceId',
        ),
      },
      objectPath: requireNonEmptyString(
        sourceObjectRef['objectPath'],
        'mappingRef.sourceObjectRef.objectPath',
      ),
    },
    ...(unitConversionsRef === undefined
      ? {}
      : { unitConversionsRef: requireNonEmptyString(unitConversionsRef, 'mappingRef.unitConversionsRef') }),
    ...(schemaRevision === undefined
      ? {}
      : { schemaRevision: requireNonEmptyString(schemaRevision, 'mappingRef.schemaRevision') }),
  }
}

function capabilityRequirementsOf(value: unknown): CapabilityRequirement[] {
  if (!Array.isArray(value)) throw new InvalidRequestFieldError('capabilities must be an array')
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`capabilities[${index}] must be an object`)
    }
    return {
      name: requireNonEmptyString(entry['name'], `capabilities[${index}].name`),
      versionRange: contractRangeOf(entry['versionRange'], `capabilities[${index}].versionRange`),
    }
  })
}

function profileRefOf(body: Record<string, unknown>): ProfileRef {
  const raw = body['profileRef']
  if (!isRecord(raw)) throw new InvalidRequestFieldError('profileRef must be an object')
  return {
    id: requireNonEmptyString(raw['id'], 'profileRef.id'),
    version: requireNonEmptyString(raw['version'], 'profileRef.version'),
  }
}

function versionOf(body: Record<string, unknown>): string {
  return requireNonEmptyString(body['version'], 'version')
}

function snapshotHashOf(body: Record<string, unknown>): string {
  return requireNonEmptyString(body['snapshotHash'], 'snapshotHash')
}

/**
 * Resolve the expected active revision. Absent means the caller did not send `If-Match`
 * and the service rejects with 428; `*` means "no active profile expected" (first
 * activation). A body field that disagrees with the header is rejected rather than guessed.
 */
function expectedRevisionOf(
  header: ReturnType<typeof readRevisionHeader>,
  body: Record<string, unknown>,
): RevisionString | null | undefined {
  let expected: RevisionString | null | undefined
  switch (header.kind) {
    case 'absent':
      expected = undefined
      break
    case 'wildcard':
      expected = null
      break
    case 'revision':
      expected = header.value
      break
    case 'invalid':
      throw new InvalidRequestFieldError('If-Match must be a decimal revision string or "*"')
  }
  const bodyRevision = body['expectedRevision']
  if (typeof bodyRevision === 'string' && bodyRevision.length > 0) {
    if (header.kind !== 'revision' || bodyRevision !== header.value) {
      throw new InvalidRequestFieldError('the body expectedRevision does not match the If-Match header')
    }
  }
  return expected
}

function componentKindOf(value: string): ComponentKind {
  const match = COMPONENT_KINDS.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new InvalidRequestFieldError(`kind must be one of: ${COMPONENT_KINDS.join(', ')}`)
  }
  return match
}

function lifecycleStateOf(value: string): ModuleLifecycleState {
  const match = LIFECYCLE_STATES.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new InvalidRequestFieldError(`lifecycleState must be one of: ${LIFECYCLE_STATES.join(', ')}`)
  }
  return match
}

/** The logical roles a resolved profile binds to a backend; the roles a preflight observed. */
function boundRoles(bindings: {
  readonly [key: string]: { readonly role: LogicalRole } | undefined
}): LogicalRole[] {
  const roles: LogicalRole[] = []
  for (const binding of Object.values(bindings)) {
    if (binding !== undefined) roles.push(binding.role)
  }
  return roles
}

export function registerWorkbenchRoutes(
  app: FastifyInstance,
  dependencies: WorkbenchRouteDependencies & { readonly authenticate: RequestAuthenticator },
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string): ToolContext =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: globalThis.crypto.randomUUID(),
    })

  app.get('/api/v1/components', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const scopeRef = scopeRefFor(auth)
    const ctx = contextFor(auth, traceId)
    requireRole(ctx, PROFILE_EDITOR_ROLES, 'listing components')

    const query = isRecord(request.query) ? request.query : {}
    const filter: ComponentListFilter = {
      ...(typeof query['kind'] === 'string' ? { kind: componentKindOf(query['kind']) } : {}),
      ...(typeof query['lifecycleState'] === 'string'
        ? { lifecycleState: lifecycleStateOf(query['lifecycleState']) }
        : {}),
    }
    const components: ComponentVersionRecord[] = await dependencies.components.listVersions(
      scopeRef,
      filter,
      ctx,
    )
    reply.status(200).send({ data: { components }, meta: { traceId } })
    return reply
  })

  app.post('/api/v1/profiles', { preHandler: requireIdempotencyKey }, async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const scopeRef = scopeRefFor(auth)
    const ctx = contextFor(auth, traceId)
    requireRole(ctx, PROFILE_EDITOR_ROLES, 'publishing a profile version')

    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const profileRef = profileRefOf(body)
    const rawSpec: unknown = body['spec']
    if (!isRecord(body['spec'])) throw new InvalidRequestFieldError('spec must be a ProfileSpec object')
    // The resolver re-validates this against the canonical ProfileSpec schema and rejects
    // any embedded secret/URL before it is persisted; the assertion only crosses the
    // untyped JSON boundary.
    const spec = rawSpec as ProfileSpec
    const environment = environmentOf(body['environment'])

    const record: ProfileVersionRecord = await dependencies.profiles.publish(
      { scopeRef, profileRef, spec, environment },
      ctx,
    )
    reply.status(201).send({ data: record, meta: { traceId } })
    return reply
  })

  app.post<{ Params: { profileId: string } }>(
    '/api/v1/profiles/:profileId/preflight',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, PROFILE_EDITOR_ROLES, 'preflighting a profile')

      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const profileRef: ProfileRef = { id: request.params.profileId, version: versionOf(body) }

      const result: PreflightResult = await dependencies.profiles.preflight({ scopeRef, profileRef }, ctx)
      if (result.status === 'resolved' && result.resolvedProfile !== undefined) {
        // Record exactly which source fingerprints this preflight observed. A later
        // mapping/capability version change then makes this preflight detectably stale.
        await dependencies.sources.recordPreflight(
          {
            scopeRef,
            profileRef,
            snapshotHash: result.resolvedProfile.snapshotHash,
            roles: boundRoles(result.resolvedProfile.backendBindings),
          },
          ctx,
        )
      }
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { profileId: string } }>(
    '/api/v1/profiles/:profileId/activate',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, PROFILE_EDITOR_ROLES, 'activating a profile')

      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const profileRef: ProfileRef = { id: request.params.profileId, version: versionOf(body) }
      const snapshotHash = snapshotHashOf(body)
      const expectedRevision = expectedRevisionOf(readRevisionHeader(request), body)

      // LOCAL-008 wiring: refuse to activate a manifest whose source bindings moved since
      // the preflight. This runs before the compare-and-set so a stale preflight is a 409
      // PREFLIGHT_STALE, never a silent activation.
      await dependencies.sources.requireFreshPreflight({ scopeRef, profileRef, snapshotHash }, ctx)

      const active: ActiveProfileRecord = await dependencies.profiles.activate(
        {
          scopeRef,
          profileRef,
          snapshotHash,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
        ctx,
      )
      reply.status(200).send({
        data: active,
        meta: { traceId, revision: active.revision },
      })
      return reply
    },
  )

  app.get<{ Params: { profileId: string } }>(
    '/api/v1/profiles/:profileId/active',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, PROFILE_EDITOR_ROLES, 'reading the active profile revision')
      const profileId = requireNonEmptyString(request.params.profileId, 'profileId')
      const active = await dependencies.profiles.getActiveProfile(scopeRef, profileId, ctx)
      reply.status(200).send({ data: { active: active ?? null }, meta: { traceId } })
      return reply
    },
  )

  app.get('/api/v1/sources', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const scopeRef = scopeRefFor(auth)
    const ctx = contextFor(auth, traceId)
    requireRole(ctx, DATA_EDITOR_ROLES, 'listing sources')
    const sources = await dependencies.sources.listSources(scopeRef, ctx)
    reply.status(200).send({ data: { sources }, meta: { traceId } })
    return reply
  })

  app.post('/api/v1/sources', { preHandler: requireIdempotencyKey }, async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const scopeRef = scopeRefFor(auth)
    const ctx = contextFor(auth, traceId)
    requireRole(ctx, DATA_EDITOR_ROLES, 'registering a source')

    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const kind = requireNonEmptyString(body['kind'], 'kind')
    if (kind !== 'read_only_origin' && kind !== 'imported') {
      throw new InvalidRequestFieldError('kind must be one of: read_only_origin, imported')
    }
    const role = logicalRoleOf(body['role'], 'role')
    const adapterRef = versionRefOf(body['adapterRef'], 'adapterRef')
    const secretRef = requireNonEmptyString(body['secretRef'], 'secretRef')
    const mappingRef = body['mappingRef']
    const capabilityVersion = body['capabilityVersion']
    if (capabilityVersion !== undefined && typeof capabilityVersion !== 'string') {
      throw new InvalidRequestFieldError('capabilityVersion must be a semver string when present')
    }

    const binding: SourceBindingRecord = await dependencies.sources.registerSource(
      {
        scopeRef,
        kind,
        role,
        adapterRef,
        secretRef,
        ...(mappingRef === undefined ? {} : { mappingRef: mappingRefOf(mappingRef) }),
        ...(capabilityVersion === undefined ? {} : { capabilityVersion }),
      },
      ctx,
    )
    reply.status(201).send({ data: binding, meta: { traceId } })
    return reply
  })

  app.post<{ Params: { sourceId: string } }>(
    '/api/v1/sources/:sourceId/probe',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const scopeRef = scopeRefFor(auth)
      const ctx = contextFor(auth, traceId)
      requireRole(ctx, DATA_EDITOR_ROLES, 'probing a source')

      const body = isRecord(request.body) ? request.body : {}
      const requested = body['capabilities']
      const job: SourceProbeJobRecord = await dependencies.sources.probeSource(
        {
          scopeRef,
          sourceId: request.params.sourceId,
          ...(requested === undefined ? {} : { capabilities: capabilityRequirementsOf(requested) }),
        },
        ctx,
      )
      reply.status(200).send({ data: job, meta: { traceId } })
      return reply
    },
  )
}
