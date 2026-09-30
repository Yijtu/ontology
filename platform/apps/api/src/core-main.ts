import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  isLoopbackAddress,
  resolveLocalDevPrincipal,
} from '@ontology/adapter-control-postgres'
import type { DeploymentEnvironment, MappingRef, ProfileRef, ProfileSpec, ScopeRef, SourceRef, VersionRef } from '@ontology/contracts'
import { createApiServer } from './http/app'
import type { ApiServerOptions } from './http/app'
import type { RequestAuthenticator } from './http/shared'
import { loadCoreExamples } from './composition/core-example-loader'
import type { LoadedCoreExamples } from './composition/core-example-loader'
import { createCoreLocalComposition } from './composition/core-local-composition'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111'
const DEFAULT_SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CORE_BUSINESS_ROLES = [
  'business-user',
  'scoped-reader',
] as const
const CORE_OPERATOR_ROLES = [
  'platform-admin',
  'profile-editor',
  'data-editor',
  'semantic-reviewer',
  'semantic-publisher',
  'operator',
] as const

export interface CoreApiDependencies {
  readonly database: { queryUnscoped(statement: string): Promise<unknown> }
  readonly scopeRef: ScopeRef
  readonly examples: LoadedCoreExamples
  readonly profileRefsByScenario?: Readonly<Record<string, ProfileRef>>
  readonly profileSpecsByScenario?: Readonly<Record<string, ProfileSpec>>
  readonly modelCapabilities?: { readonly generation: boolean; readonly decision: boolean }
  readonly availableTaskIds?: readonly string[]
  readonly availableTasksByScenario?: Readonly<Record<string, readonly string[]>>
  readonly readScenarioProfile?: (scenarioId: string) => Promise<{
    readonly profileRef: ProfileRef
    readonly baseProfileSpec: ProfileSpec
    readonly environment: DeploymentEnvironment
    readonly availableTasks: readonly string[]
    readonly definitionRef: VersionRef
    readonly namespace: string
    readonly label: string
    readonly sourceScenarioId: string
    readonly mappingRefs: readonly MappingRef[]
    readonly rawSourceRefs: readonly SourceRef[]
    readonly models: { readonly generation: boolean; readonly decision: boolean }
  } | undefined>
  readonly api?: Omit<ApiServerOptions, 'authenticate' | 'logger'>
  readonly allowLocalOperator?: boolean
  readonly registerRoutes?: (
    app: FastifyInstance,
    authenticate: RequestAuthenticator,
  ) => void
  readonly logger?: boolean
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 3001
  if (!/^[1-9]\d{0,4}$/u.test(value)) throw new Error('CORE_API_PORT must be an integer between 1 and 65535')
  const port = Number(value)
  if (port > 65_535) throw new Error('CORE_API_PORT must be an integer between 1 and 65535')
  return port
}

function scopeFromEnvironment(): ScopeRef {
  const tenantId = process.env['CORE_TENANT_ID'] ?? DEFAULT_TENANT_ID
  const spaceId = process.env['CORE_SPACE_ID'] ?? DEFAULT_SPACE_ID
  if (!isUuid(tenantId) || !isUuid(spaceId)) throw new Error('CORE_TENANT_ID and CORE_SPACE_ID must be UUIDs')
  return { tenantId: tenantId.toLowerCase(), spaceId: spaceId.toLowerCase() }
}

function authenticateLocalRequest(request: FastifyRequest, scopeRef: ScopeRef, allowOperator: boolean) {
  const remoteAddress = request.raw.socket.remoteAddress ?? ''
  if (!isLoopbackAddress(remoteAddress)) return undefined
  try {
    return {
      principal: resolveLocalDevPrincipal(remoteAddress, 'development', {
        tenantId: scopeRef.tenantId,
        roles: [...CORE_BUSINESS_ROLES, ...(allowOperator ? CORE_OPERATOR_ROLES : [])],
        scopes: [],
        authEpoch: 1,
      }),
      spaceId: scopeRef.spaceId,
    }
  } catch {
    return undefined
  }
}

/** Build the local Core API using only its explicit deployment scope and validated example declarations. */
export function createCoreApi(dependencies: CoreApiDependencies): FastifyInstance {
  const authenticate = (request: FastifyRequest) => authenticateLocalRequest(
    request,
    dependencies.scopeRef,
    dependencies.allowLocalOperator ?? false,
  )
  const app = createApiServer({
    ...(dependencies.api ?? {}),
    authenticate,
    logger: dependencies.logger ?? false,
  })
  dependencies.registerRoutes?.(app, authenticate)

  app.get('/healthz', async (_request, reply) => {
    try {
      await dependencies.database.queryUnscoped('SELECT 1')
      return reply.status(200).send({ status: 'ready', controlStore: 'connected' })
    } catch {
      return reply.status(503).send({ status: 'not_ready', controlStore: 'unavailable' })
    }
  })

  app.get('/api/v1/core/deployment', async (request, reply) => {
    const authenticated = authenticate(request)
    if (authenticated === undefined) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'loopback development authentication is required', retryable: false } })
    }
    const scenarios = await Promise.all(dependencies.examples.scenarios.map(async (scenario) => {
      const current = await dependencies.readScenarioProfile?.(scenario.scenarioId)
      const profileRef = current?.profileRef ?? dependencies.profileRefsByScenario?.[scenario.scenarioId] ?? scenario.profileRef
      const baseProfileSpec = current?.baseProfileSpec ?? dependencies.profileSpecsByScenario?.[scenario.scenarioId]
      return {
        scenarioId: scenario.scenarioId,
        label: current?.label ?? scenario.label,
        sourceScenarioId: current?.sourceScenarioId ?? scenario.scenarioId,
        profileRef,
        environment: current?.environment ?? 'local_dev',
        namespace: current?.namespace ?? scenario.namespace,
        definitionRef: current?.definitionRef ?? scenario.definitionRef,
        ...(baseProfileSpec === undefined ? {} : { baseProfileSpec }),
        availableTasks: current?.availableTasks ?? dependencies.availableTasksByScenario?.[scenario.scenarioId] ?? dependencies.availableTaskIds ?? [],
        mappingRefs: current?.mappingRefs ?? scenario.physicalMappings.map((mapping) => mapping.ref),
        rawSourceRefs: current?.rawSourceRefs ?? scenario.rawSources.map((source) => source.sourceRef),
        models: current?.models ?? dependencies.modelCapabilities ?? { generation: false, decision: false },
      }
    }))
    return reply.status(200).send({
      data: {
        classification: dependencies.examples.classification,
        scenarios,
        operatorEnabled: dependencies.allowLocalOperator ?? false,
        models: dependencies.modelCapabilities ?? { generation: false, decision: false },
      },
    })
  })

  return app
}

export async function startCoreApi(): Promise<void> {
  const scopeRef = scopeFromEnvironment()
  let composition: Awaited<ReturnType<typeof createCoreLocalComposition>> | undefined
  let app: FastifyInstance | undefined
  try {
    const examples = loadCoreExamples({
      targetScopeRef: scopeRef,
      ...(process.env['CORE_DEPLOYMENT_CONFIG'] === undefined ? {} : { indexPath: process.env['CORE_DEPLOYMENT_CONFIG'] }),
    })
    composition = await createCoreLocalComposition({
      databaseUrl: requiredEnv('CORE_DATABASE_URL'),
      objectDirectory: process.env['CORE_OBJECT_DIRECTORY'] ?? resolve(tmpdir(), 'ontology-core-local', scopeRef.tenantId, scopeRef.spaceId, 'objects'),
      scopeRef,
      examples,
      allowLocalOperator: process.env['CORE_ENABLE_OPERATOR_ROUTES'] === 'true',
      modelsEnabled: process.env['CORE_ENABLE_MODELS'] === 'true',
      jevEnabled: process.env['CORE_ENABLE_JEV'] === 'true',
      modelEnvironment: process.env,
    })
    app = createCoreApi({ ...composition.dependencies, logger: true })
    await app.listen({ host: '127.0.0.1', port: readPort(process.env['CORE_API_PORT']) })
    const shutdown = async (): Promise<void> => {
      await app?.close()
      await composition?.close()
    }
    process.once('SIGINT', () => { void shutdown().finally(() => { process.exitCode = 0 }) })
    process.once('SIGTERM', () => { void shutdown().finally(() => { process.exitCode = 0 }) })
  } catch (error) {
    await app?.close().catch(() => undefined)
    await composition?.close().catch(() => undefined)
    throw error
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/apps/api/src/core-main.ts') === true) {
  startCoreApi().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected Core startup failure'
    process.stderr.write(`Core API startup failed: ${message}\n`)
    process.exitCode = 1
  })
}
