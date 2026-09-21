import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { RunService } from '@ontology/application'
import { registerRunRoutes } from './server'
import type { RunApiOptions } from './server'
import { registerWorkbenchRoutes } from './workbench'
import type { WorkbenchRouteDependencies } from './workbench'
import { installErrorHandler } from './shared'
import type { RequestAuthenticator } from './shared'

/**
 * The composition point for the HTTP host. Every route group is registered onto ONE
 * Fastify instance so they share the envelope, the error boundary and the trusted-context
 * convention; there is no second server and no per-group copy of the auth handling.
 */
export interface ApiServerOptions {
  readonly authenticate: RequestAuthenticator
  /** Register the run surface (`POST /runs`, events, cancel, resume). */
  readonly runs?: { readonly service: RunService }
  /** Register the configuration workbench surface (components/profiles/sources). */
  readonly workbench?: WorkbenchRouteDependencies
  readonly logger?: boolean
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })
  installErrorHandler(app)
  if (options.runs !== undefined) {
    registerRunRoutes(app, { service: options.runs.service, authenticate: options.authenticate })
  }
  if (options.workbench !== undefined) {
    registerWorkbenchRoutes(app, { ...options.workbench, authenticate: options.authenticate })
  }
  return app
}

/** Convenience wrapper kept for the run-only surface and its existing callers. */
export function createRunApi(options: RunApiOptions): FastifyInstance {
  return createApiServer({
    authenticate: options.authenticate,
    runs: { service: options.service },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}
