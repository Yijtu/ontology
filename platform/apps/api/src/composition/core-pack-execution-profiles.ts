import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { canonicalJson, publishedPackContentDigest, sha256DigestOf } from '@ontology/application'
import type { ComponentRegistry, ProfileResolver } from '@ontology/application'
import { isRecord, isVersionRef } from '@ontology/contracts'
import type { Capability, MappingRef, ProfileRef, PublishedPackAsset, PublishedPackAssetStore, SemanticDefinitionStore, ToolContext, VersionRef } from '@ontology/contracts'
import { definitionVersionDigest } from '@ontology/semantic-engine'
import type { createCoreAuthoring } from './core-authoring'
import { createRequestToolContext } from '../http/context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, readHeader, readTraceId } from '../http/shared'
import type { RequestAuthenticator } from '../http/shared'

/** Explicit operator configuration of a real immutable pack; no current-draft or approval clone. */
export function createCorePackExecutionProfiles(options: {
  readonly packs: Pick<PublishedPackAssetStore, 'findByRef'>; readonly definitions: SemanticDefinitionStore
  readonly components: ComponentRegistry; readonly profiles: ProfileResolver; readonly authoring: ReturnType<typeof createCoreAuthoring>
  readonly executionProfileRef: ProfileRef; readonly dataBackendRef: VersionRef; readonly semanticCapability: Capability
}) {
  const prepare = async (asset: PublishedPackAsset, ctx: ToolContext) => {
    if (!ctx.principal.roles.includes('platform-admin')) throw new ForbiddenError('preparing an executable project configuration requires the component operator')
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const stored = await options.packs.findByRef(scope, asset.packRef, ctx)
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(asset) || publishedPackContentDigest(stored) !== asset.packRef.digest || !asset.capabilities.semanticPublished) throw new InvalidRequestFieldError('the selected immutable pack is not an actual scoped semantic publication')
    const definition = await options.definitions.findVersion(asset.namespace, asset.definitionRef.id, asset.definitionRef.version, scope, ctx)
    if (definition === undefined || definitionVersionDigest(definition) !== asset.definitionRef.digest) throw new InvalidRequestFieldError('the published pack has no exact stored definition body')
    const artifact = await options.authoring.stableWrite(`execution-pack:${asset.packRef.id}@${asset.packRef.version}`, new TextEncoder().encode(canonicalJson(asset)), 'application/vnd.ontology.published-pack+json', 'artifact', ctx)
    const manifest = { kind: 'industry_pack' as const, id: asset.packRef.id, version: asset.packRef.version, digest: asset.packRef.digest,
      contractRange: { min: '0.2.0', max: '1.0.0' }, provides: [options.semanticCapability], requires: [],
      entrypointRef: { kind: 'package' as const, ref: 'declarative-industry-manifest' }, trustStatus: 'local_dev' as const, namespace: asset.namespace }
    let component = await options.components.register({ scopeRef: scope, manifest, artifactRef: artifact, source: 'operator' }, ctx)
    if (component.lifecycleState === 'deprecated' || component.lifecycleState === 'retired') throw new InvalidRequestFieldError('a withdrawn component cannot be reactivated by configuration retry')
    if (component.lifecycleState === 'registered') component = await options.components.transition({ scopeRef: scope, kind: 'industry_pack', ref: asset.packRef, to: 'validated' }, ctx)
    if (component.lifecycleState === 'validated') component = await options.components.transition({ scopeRef: scope, kind: 'industry_pack', ref: asset.packRef, to: 'active' }, ctx)
    if (component.lifecycleState !== 'active') throw new InvalidRequestFieldError('the actual published pack component is unavailable')
    const catalogue = await options.authoring.stableWrite(`execution-catalogue:${asset.definitionRef.digest}`, new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-project-snapshot-catalogue@1', definitionRef: asset.definitionRef, identityScopes: definition.identityScopes, binding: 'host-allocated fixed project snapshots only' })), 'application/json', 'artifact', ctx)
    const mapping: MappingRef = { id: catalogue.id, version: catalogue.version, digest: catalogue.digest, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'core-project-snapshots', sourceId: catalogue.id }, objectPath: 'fixed_project_snapshots' } }
    const host = await options.profiles.getProfileVersion({ scopeRef: scope, profileRef: options.executionProfileRef }, ctx)
    const profileRef = { id: `${asset.packRef.id}.execution`, version: asset.packRef.version }
    await options.profiles.publish({ scopeRef: scope, profileRef, environment: 'local_dev', spec: { ...host.spec, industryRef: asset.packRef, mappingRefs: [mapping], backendBindings: { catalog: { role: 'catalog', adapterRef: options.dataBackendRef, mappingRef: mapping.id } } } }, ctx)
    const resolved = await options.profiles.bindRunProfile(profileRef, scope, ctx)
    return { definition, profileRef: resolved.resolvedProfileRef }
  }
  return { prepare, register(app: FastifyInstance, authenticate: RequestAuthenticator) {
    app.post('/api/v1/core/published-pack-profiles', async (request, reply) => {
      const auth = authenticateRequest(authenticate, request, reply); if (auth === undefined) return reply
      if (!auth.principal.roles.includes('platform-admin')) throw new ForbiddenError('project configuration requires the component operator')
      const body = request.body, key = readHeader(request, 'idempotency-key'), traceId = readTraceId(request)
      if (!isRecord(body) || Object.keys(body).some((field) => field !== 'packRef') || !isVersionRef(body['packRef']) || key === undefined || key.length < 8 || key.length > 200) throw new InvalidRequestFieldError('choose an actual published pack and provide a configuration retry key')
      const ctx = createRequestToolContext({ ...auth, traceId, runId: randomUUID() }), scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
      await options.authoring.stableWrite(`pack-project-profile-request:${sha256DigestOf(key)}`, new TextEncoder().encode(canonicalJson({ packRef: body['packRef'], principal: ctx.principal })), 'application/json', 'artifact', ctx)
      const asset = await options.packs.findByRef(scope, body['packRef'], ctx)
      if (asset === undefined) throw new InvalidRequestFieldError('the selected exact published pack is unavailable')
      const configured = await prepare(asset, ctx)
      return reply.send({ data: { purpose: 'business_project_configuration', packRef: asset.packRef, definitionRef: asset.definitionRef, profileRef: configured.profileRef, capabilities: asset.capabilities }, meta: { traceId } })
    })
  } }
}
