import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CoreLocalModelSettings } from '../composition/core-local-model-settings'
import { ForbiddenError } from './shared'
import type { RequestAuthenticator } from './shared'

/**
 * The legacy single-configuration surface, kept in explicit legacy mode (design §5.3).
 *
 * Once the one-time bridge has run, the multi-model catalogue owns the truth. This surface then
 * refuses reads and writes with `MODEL_SETTINGS_MIGRATED`, so an old client cannot overwrite the
 * new catalogue by saving the single-generation config again.
 */
export class ModelSettingsMigratedError extends Error {
  readonly code = 'MODEL_SETTINGS_MIGRATED'
  readonly httpStatus = 409

  constructor() {
    super('模型设置已迁移到多模型目录，请使用新的 AI 设置接口。')
    this.name = 'ModelSettingsMigratedError'
  }
}

export interface CoreModelSettingsMigrationGuard {
  isMigrated(): Promise<boolean>
}

/** Only the trusted local Core operator can read or change deployment credentials. */
export function registerCoreModelSettingsRoutes(app: FastifyInstance, input: {
  readonly settings: CoreLocalModelSettings
  readonly authenticate: RequestAuthenticator
  readonly webPort: number
  readonly migration?: CoreModelSettingsMigrationGuard
}): void {
  const authorized = (request: FastifyRequest) => {
    const auth = input.authenticate(request)
    if (auth === undefined || !auth.principal.roles.includes('platform-admin') || auth.principal.tenantId !== input.settings.scopeRef.tenantId || auth.spaceId !== input.settings.scopeRef.spaceId) throw new ForbiddenError('需要当前工作空间的本机管理员权限才能配置生成模型。')
    const host = request.headers.host ?? ''
    const origin = request.headers.origin
    let hostname = ''
    let hostOrigin = ''
    try {
      const url = new URL(`http://${host}`)
      if (!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) { hostname = url.hostname; hostOrigin = url.origin }
    } catch { /* Invalid hosts are rejected below. */ }
    const origins = new Set([hostOrigin, `http://127.0.0.1:${input.webPort}`, `http://localhost:${input.webPort}`])
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || origin !== undefined && !origins.has(origin)) throw new ForbiddenError('模型设置仅允许从本机工作台访问。')
    return auth
  }
  const guardMigrated = async () => {
    if (input.migration !== undefined && await input.migration.isMigrated()) throw new ModelSettingsMigratedError()
  }
  app.get('/api/v1/core/model-settings', async (request) => {
    authorized(request)
    await guardMigrated()
    return { data: await input.settings.read() }
  })
  app.put('/api/v1/core/model-settings', { bodyLimit: 16_384 }, async (request) => {
    authorized(request)
    await guardMigrated()
    return { data: await input.settings.save(request.body) }
  })
  app.post('/api/v1/core/model-settings/test', { bodyLimit: 16_384 }, async (request, reply) => {
    authorized(request)
    await guardMigrated()
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    if (request.raw.aborted) controller.abort()
    try { return { data: await input.settings.test(request.body, controller.signal) } }
    finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort) }
  })
}
