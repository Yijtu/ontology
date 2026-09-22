import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { JobService, RunService } from '@ontology/application'
import { registerRunRoutes } from './server'
import type { RunApiOptions } from './server'
import { registerJobRoutes } from './jobs'
import type { JobApiOptions } from './jobs'
import { registerWorkbenchRoutes } from './workbench'
import type { WorkbenchRouteDependencies } from './workbench'
import { registerDecisionRoutes } from './decisions'
import type { DecisionRouteDependencies } from './decisions'
import { registerPublicationRoutes } from './publication'
import type { PublicationRouteDependencies } from './publication'
import { registerPackRoutes } from './packs'
import type { PackRouteDependencies } from './packs'
import { registerEvidenceRoutes } from './evidence'
import type { EvidenceRouteDependencies } from './evidence'
import { registerHistoryRoutes } from './history'
import type { HistoryRouteDependencies } from './history'
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
  /** Register the durable-job surface (`POST /ingestions`, `GET /jobs/{id}`, retry). */
  readonly jobs?: { readonly service: JobService }
  /** Register the configuration workbench surface (components/profiles/sources). */
  readonly workbench?: WorkbenchRouteDependencies
  /** Register the candidate review surface (`GET /candidates`, `POST /candidates/{id}/decision`). */
  readonly decisions?: Omit<DecisionRouteDependencies, 'authenticate'>
  /** Register the semantic publication surface (`POST /semantic-publications`, revisions). */
  readonly publications?: Omit<PublicationRouteDependencies, 'authenticate'>
  /** Register the industry-pack export/upgrade surface (`/industry-packs`). */
  readonly packs?: Omit<PackRouteDependencies, 'authenticate'>
  /** Register the on-demand provenance surface (`GET /evidence/{id}`, dependencies, export). */
  readonly evidence?: Omit<EvidenceRouteDependencies, 'authenticate'>
  /** Register the object history surface (`GET /objects/{id}/history`). */
  readonly history?: Omit<HistoryRouteDependencies, 'authenticate'>
  readonly logger?: boolean
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })
  installErrorHandler(app)
  if (options.runs !== undefined) {
    registerRunRoutes(app, { service: options.runs.service, authenticate: options.authenticate })
  }
  if (options.jobs !== undefined) {
    registerJobRoutes(app, { service: options.jobs.service, authenticate: options.authenticate })
  }
  if (options.workbench !== undefined) {
    registerWorkbenchRoutes(app, { ...options.workbench, authenticate: options.authenticate })
  }
  if (options.decisions !== undefined) {
    registerDecisionRoutes(app, { ...options.decisions, authenticate: options.authenticate })
  }
  if (options.publications !== undefined) {
    registerPublicationRoutes(app, { ...options.publications, authenticate: options.authenticate })
  }
  if (options.packs !== undefined) {
    registerPackRoutes(app, { ...options.packs, authenticate: options.authenticate })
  }
  if (options.evidence !== undefined) {
    registerEvidenceRoutes(app, { ...options.evidence, authenticate: options.authenticate })
  }
  if (options.history !== undefined) {
    registerHistoryRoutes(app, { ...options.history, authenticate: options.authenticate })
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

/** Convenience wrapper for the job-only surface and focused tests. */
export function createJobApi(options: JobApiOptions): FastifyInstance {
  return createApiServer({
    authenticate: options.authenticate,
    jobs: { service: options.service },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}
