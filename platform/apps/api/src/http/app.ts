import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { JobService, RunService } from '@ontology/application'
import { registerRunRoutes } from './server'
import type { RunApiOptions } from './server'
import type { RunProgressReader } from './run-progress'
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
import { registerAnswerRoutes } from './answers'
import type { AnswerRouteDependencies } from './answers'
import { registerFeedbackRoutes } from './feedback'
import type { FeedbackRouteDependencies } from './feedback'
import { registerIndustryWorkspaceRoutes } from './industry-workspaces'
import type { IndustryWorkspaceRouteDependencies } from './industry-workspaces'
import { registerAssetCandidateRoutes } from './asset-candidates'
import type { AssetCandidateRouteDependencies } from './asset-candidates'
import { registerDefinitionEditingRoutes } from './definition-editing'
import type { DefinitionEditingRouteDependencies } from './definition-editing'
import { registerRuleActionCandidateRoutes } from './rule-action-candidates'
import type { RuleActionCandidateRouteDependencies } from './rule-action-candidates'
import { registerInstanceReviewRoutes } from './instances'
import type { InstanceReviewRouteDependencies } from './instances'
import { registerSyntheticValidationRoutes } from './synthetic-validation'
import type { SyntheticValidationRouteDependencies } from './synthetic-validation'
import { registerProjectRoutes } from './projects'
import type { ProjectRouteDependencies } from './projects'
import { registerProjectDocumentRoutes } from './project-documents'
import type { ProjectDocumentRouteDependencies } from './project-documents'
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
  readonly runs?: {
    readonly service: RunService
    readonly progress?: RunProgressReader
    readonly dispatch?: RunApiOptions['dispatch']
    readonly validateSubmission?: RunApiOptions['validateSubmission']
    readonly submissionMode?: RunApiOptions['submissionMode']
  }
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
  /** Register the verified-answer surface (`GET /runs/{id}/answer`). */
  readonly answers?: Omit<AnswerRouteDependencies, 'authenticate'>
  /** Register the append-only feedback surface (`POST/GET /runs/{id}/feedback`). */
  readonly feedback?: Omit<FeedbackRouteDependencies, 'authenticate'>
  /** Register the industry-workspace draft management surface (`/industry-workspaces`). */
  readonly industryWorkspaces?: Omit<IndustryWorkspaceRouteDependencies, 'authenticate'>
  /** Register the definition-candidate generation surface (`/industry-workspaces/:id/generations`). */
  readonly assetCandidates?: Omit<AssetCandidateRouteDependencies, 'authenticate'>
  /** Register the definition editing/validation surface (`/industry-workspaces/:id/candidates/:id/edits`). */
  readonly definitionEditing?: Omit<DefinitionEditingRouteDependencies, 'authenticate'>
  /** Register the rule/action candidate surface (`/industry-workspaces/:id/rule-action-candidates`). */
  readonly ruleActionCandidates?: Omit<RuleActionCandidateRouteDependencies, 'authenticate'>
  /** Register the public instance review surface (`/projects/:id/instance-records`). */
  readonly instanceReviews?: Omit<InstanceReviewRouteDependencies, 'authenticate'>
  /** Register the synthetic sandbox / industry validation surface (`/industry-workspaces/:id/validations`). */
  readonly syntheticValidation?: Omit<SyntheticValidationRouteDependencies, 'authenticate'>
  /** Register the customer-project, pack-mounting and readiness surface (`/projects`). */
  readonly projects?: Omit<ProjectRouteDependencies, 'authenticate'>
  /** Register the project document corpus and search surface (`/projects/:id/document-*`). */
  readonly projectDocuments?: Omit<ProjectDocumentRouteDependencies, 'authenticate'>
  readonly logger?: boolean
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })
  installErrorHandler(app)
  if (options.runs !== undefined) {
    registerRunRoutes(app, {
      service: options.runs.service,
      authenticate: options.authenticate,
      ...(options.runs.progress === undefined ? {} : { progress: options.runs.progress }),
      ...(options.runs.dispatch === undefined ? {} : { dispatch: options.runs.dispatch }),
      ...(options.runs.validateSubmission === undefined ? {} : { validateSubmission: options.runs.validateSubmission }),
      ...(options.runs.submissionMode === undefined ? {} : { submissionMode: options.runs.submissionMode }),
    })
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
  if (options.answers !== undefined) {
    registerAnswerRoutes(app, { ...options.answers, authenticate: options.authenticate })
  }
  if (options.feedback !== undefined) {
    registerFeedbackRoutes(app, { ...options.feedback, authenticate: options.authenticate })
  }
  if (options.industryWorkspaces !== undefined) {
    registerIndustryWorkspaceRoutes(app, {
      ...options.industryWorkspaces,
      authenticate: options.authenticate,
    })
  }
  if (options.assetCandidates !== undefined) {
    registerAssetCandidateRoutes(app, {
      ...options.assetCandidates,
      authenticate: options.authenticate,
    })
  }
  if (options.definitionEditing !== undefined) {
    registerDefinitionEditingRoutes(app, {
      ...options.definitionEditing,
      authenticate: options.authenticate,
    })
  }
  if (options.ruleActionCandidates !== undefined) {
    registerRuleActionCandidateRoutes(app, {
      ...options.ruleActionCandidates,
      authenticate: options.authenticate,
    })
  }
  if (options.instanceReviews !== undefined) {
    registerInstanceReviewRoutes(app, {
      ...options.instanceReviews,
      authenticate: options.authenticate,
    })
  }
  if (options.syntheticValidation !== undefined) {
    registerSyntheticValidationRoutes(app, {
      ...options.syntheticValidation,
      authenticate: options.authenticate,
    })
  }
  if (options.projects !== undefined) {
    registerProjectRoutes(app, {
      ...options.projects,
      authenticate: options.authenticate,
    })
  }
  if (options.projectDocuments !== undefined) {
    registerProjectDocumentRoutes(app, {
      ...options.projectDocuments,
      authenticate: options.authenticate,
    })
  }
  return app
}

/** Convenience wrapper kept for the run-only surface and its existing callers. */
export function createRunApi(options: RunApiOptions): FastifyInstance {
  return createApiServer({
    authenticate: options.authenticate,
    runs: {
      service: options.service,
      ...(options.progress === undefined ? {} : { progress: options.progress }),
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      ...(options.validateSubmission === undefined ? {} : { validateSubmission: options.validateSubmission }),
      ...(options.submissionMode === undefined ? {} : { submissionMode: options.submissionMode }),
    },
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
