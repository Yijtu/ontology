import { randomUUID } from 'node:crypto'
import type {
  AssetCandidateVersion,
  AssetDraftVersion,
  CandidateRecord,
  DocumentChunkRecord,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IndustryWorkspaceWriteResult,
  ModelRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import {
  DefinitionCandidateGenerationService,
  ExtractionPipeline,
  InMemoryAssetCandidateStore,
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  StaticDefinitionTerminologySource,
  TBOX_RESPONSE_SCHEMA_REF,
  canonicalJson,
  sha256DigestOf,
} from '@ontology/application'
import type { ExtractionInput, ExtractionRunContext } from '@ontology/application'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { RecordingControlRepository, toolContext } from '../../unit/component-registry-fixtures'
import {
  EVAL_SOURCE_REF,
  MODELLING_PARAMETER_EVAL_SET,
  evalSetProjection,
} from './fixed-set'
import type { ModellingEvalCase, ModellingParameterCase, ParameterEvalCase } from './fixed-set'
import {
  buildControlledVerification,
  buildReadinessReport,
} from './readiness-report'
import type { ControlledVerification, ModelReadinessReport, RealModelRun } from './readiness-report'
import { evaluationMatchesExpected, scoreAgainstReference } from './scoring'
import type { CaseEvaluation, ObservedItem } from './scoring'

/**
 * The controlled/loopback modelling / parameter-extraction evaluation harness (V03-046).
 *
 * It replays the FIXED set (`fixed-set.ts`) against the real services — the definition
 * candidate generation service (V03-008) and the extraction pipeline (V03-007) — but drives
 * them with a fixed, controlled generation port that never contacts a real or paid model.
 * The scored result is compared with the independently authored expectation, so a green run
 * proves the harness detects a wrong value, an omission and a fabrication. It is NOT a
 * quality claim about any model; a real quality claim requires `RealModelRun` evidence.
 *
 * The harness reads no secret and writes none: the controlled port replays in-memory JSON.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const JOB_ID = '88888888-8888-4888-8888-888888888888'
const PARSE_ID = '99999999-9999-4999-8999-999999999998'
const FIXED_NOW = '2026-09-30T00:00:00.000Z'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const MODEL_REF: ModelRef = { modelId: 'controlled-eval-model', version: '1.0.0' }
const POLICY_REF: VersionRef = { id: 'policy.tbox', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }

function fixedWorkspace(): IndustryWorkspace {
  return {
    workspaceId: WORKSPACE_ID,
    namespace: 'modelling-eval',
    displayName: 'Modelling evaluation workspace',
    boundary: { goals: ['model the fixed source'], included: ['catalogue'], excluded: ['pricing'], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function fixedDraft(): AssetDraftVersion {
  return {
    workspaceId: WORKSPACE_ID,
    revision: '1',
    digest: `sha256:${'d'.repeat(64)}`,
    documentSetRef: EVAL_SOURCE_REF,
    candidateRefs: [],
  }
}

/** A read-only workspace store exposing exactly the head and draft the generator reads. */
class FixedWorkspaceStore implements IndustryWorkspaceStore {
  readonly #workspace: IndustryWorkspace
  readonly #drafts: readonly AssetDraftVersion[]

  constructor(workspace: IndustryWorkspace, drafts: readonly AssetDraftVersion[]) {
    this.#workspace = workspace
    this.#drafts = drafts
  }

  async getWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspace | undefined> {
    void _ctx
    if (scopeRef.tenantId !== TENANT || scopeRef.spaceId !== SPACE) return undefined
    return workspaceId === this.#workspace.workspaceId ? this.#workspace : undefined
  }

  async listDrafts(scopeRef: ScopeRef, _workspaceId: Uuid, _ctx: ToolContext): Promise<AssetDraftVersion[]> {
    void _workspaceId
    void _ctx
    if (scopeRef.tenantId !== TENANT || scopeRef.spaceId !== SPACE) return []
    return [...this.#drafts]
  }

  async createWorkspace(
    _input: Parameters<IndustryWorkspaceStore['createWorkspace']>[0],
    _scopeRef: ScopeRef,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    void _input
    void _scopeRef
    void _ctx
    throw new Error('the evaluation harness never creates a workspace')
  }

  async listWorkspaces(
    _scopeRef: ScopeRef,
    _filter: IndustryWorkspaceListFilter,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspace[]> {
    void _scopeRef
    void _filter
    void _ctx
    throw new Error('the evaluation harness never lists workspaces')
  }

  async getDraft(
    _scopeRef: ScopeRef,
    _workspaceId: Uuid,
    _revision: RevisionString,
    _ctx: ToolContext,
  ): Promise<AssetDraftVersion | undefined> {
    void _scopeRef
    void _workspaceId
    void _revision
    void _ctx
    throw new Error('the evaluation harness never resolves a draft by revision')
  }

  async appendDraft(
    _scopeRef: ScopeRef,
    _workspaceId: Uuid,
    _input: Parameters<IndustryWorkspaceStore['appendDraft']>[2],
    _ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    void _scopeRef
    void _workspaceId
    void _input
    void _ctx
    throw new Error('the evaluation harness never appends a draft')
  }
}

/** A controlled `GenerationPort`: it replays one fixed JSON payload and never calls out. */
class FixedGenerationPort implements GenerationPort {
  readonly #text: string

  constructor(output: unknown) {
    this.#text = JSON.stringify(output)
  }

  async *generate(_request: GenerationRequest, _ctx: ToolContext): AsyncGenerator<GenerationEvent> {
    void _request
    void _ctx
    const events: readonly GenerationEvent[] = [
      { type: 'text_delta', text: this.#text },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'completed', stopReason: 'stop', candidateOnly: true },
    ]
    for (const event of events) yield event
  }
}

function createBudgetService(): BudgetService {
  return new BudgetService({
    store: new InMemoryBudgetLedgerStore(),
    control: new RecordingControlRepository(),
    now: () => FIXED_NOW,
    newId: () => randomUUID(),
  })
}

function chunkOf(text: string, ordinal: number): DocumentChunkRecord {
  return {
    chunkId: randomUUID(),
    ordinal,
    chunkKind: 'paragraph',
    text,
    textDigest: sha256DigestOf(text),
    locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: sha256DigestOf(`quote:${text}`),
    conditions: [],
    exceptions: [],
  }
}

/** Project one definition candidate onto the implementation-neutral observed form. */
function definitionObserved(candidate: AssetCandidateVersion): ObservedItem {
  const payload = candidate.payload
  if (payload.kind === 'object') return { key: `object:${payload.logicalId}`, fields: {} }
  if (payload.kind === 'attribute') {
    return {
      key: `attribute:${payload.logicalId}`,
      fields: {
        object: payload.objectLogicalId,
        valueType: payload.valueType,
        unit: payload.unitCode ?? '',
        enum: (payload.enumValues ?? []).join(','),
      },
    }
  }
  return {
    key: `relation:${payload.logicalId}`,
    fields: { from: payload.fromObjectLogicalId, to: payload.toObjectLogicalId },
  }
}

function payloadConflicts(candidate: AssetCandidateVersion): string[] {
  return candidate.payload.conflicts.map((conflict) => `${conflict.kind}:${conflict.message}`)
}

async function evaluateModellingCase(entry: ModellingEvalCase): Promise<CaseEvaluation> {
  const ctx = toolContext(TENANT, SPACE, ['profile-editor'], 'modelling-eval')
  const service = new DefinitionCandidateGenerationService({
    workspaces: new FixedWorkspaceStore(fixedWorkspace(), [fixedDraft()]),
    candidates: new InMemoryAssetCandidateStore(),
    terminology: new StaticDefinitionTerminologySource([], entry.terminology),
    generationForRun: () => new FixedGenerationPort(entry.controlledModelOutput),
    modelRef: MODEL_REF,
    responseSchemaRef: TBOX_RESPONSE_SCHEMA_REF,
    outputLimit: { maxTokens: 1_024 },
    now: () => FIXED_NOW,
    newId: () => randomUUID(),
  })
  const result = await service.generate(
    {
      workspaceId: WORKSPACE_ID,
      expectedRevision: '1',
      sourceRefs: [EVAL_SOURCE_REF],
      kinds: entry.allowedKinds,
      generationPolicyRef: POLICY_REF,
      idempotencyKey: `modelling-eval-${entry.caseId}`,
    },
    'modelling-eval',
    ctx,
  )
  const observed = result.candidates.map(definitionObserved)
  const disambiguation = result.candidates.flatMap(payloadConflicts)
  return { caseId: entry.caseId, family: 'modelling', ...scoreAgainstReference(entry.reference, observed, disambiguation) }
}

function parameterObserved(stored: readonly CandidateRecord[]): { observed: ObservedItem[]; disambiguation: string[] } {
  const observed: ObservedItem[] = []
  const disambiguation: string[] = []
  for (const candidate of stored) {
    if (candidate.kind === 'entity') {
      observed.push({ key: `entity:${candidate.objectId}`, fields: {} })
      for (const attribute of candidate.attributes) {
        observed.push({
          key: `attribute:${candidate.objectId}.${attribute.attributeId}`,
          fields: { value: attribute.decimal ?? String(attribute.value), unit: attribute.unitCode ?? '' },
        })
      }
      for (const issue of candidate.issues) disambiguation.push(`${issue.code}:${issue.message}`)
    } else if (candidate.kind === 'relation') {
      observed.push({
        key: `relation:${candidate.relationId}`,
        fields: { from: candidate.from.objectId, to: candidate.to.objectId },
      })
    }
  }
  return { observed, disambiguation }
}

async function evaluateParameterCase(entry: ParameterEvalCase): Promise<CaseEvaluation> {
  const ctx = toolContext(TENANT, SPACE, ['data-editor'], 'parameter-eval')
  const budget = createBudgetService()
  const ledgerId = randomUUID()
  await budget.openLedger({ ledgerId, kind: 'background' }, ctx)
  const candidates = new InMemoryCandidateStore()
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: entry.schema.definitionRef, schema: entry.schema }]),
    generation: new FixedGenerationPort(entry.controlledModelOutput),
    candidates,
    budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: () => FIXED_NOW,
  })
  const input: ExtractionInput = {
    jobId: JOB_ID,
    parseId: PARSE_ID,
    parserVersion: '1.0.0',
    pipelineVersion: '1.0.0',
    definitionRef: entry.schema.definitionRef,
    chunks: [chunkOf(entry.sourceText, 0)],
    truncatedChunkIds: [],
  }
  const run: ExtractionRunContext = { ledgerId, ctx, signal: new AbortController().signal }
  await pipeline.extract(input, run)
  await pipeline.validate(input, run)
  const stored = await candidates.listCandidates(SCOPE, { jobId: JOB_ID }, ctx)
  const { observed, disambiguation } = parameterObserved(stored)
  return { caseId: entry.caseId, family: 'parameter', ...scoreAgainstReference(entry.reference, observed, disambiguation) }
}

export interface ModellingParameterEvaluationResult {
  readonly setDigest: string
  readonly cases: readonly CaseEvaluation[]
  readonly controlled: ControlledVerification
  readonly report: ModelReadinessReport
}

export interface ModellingParameterEvaluationOptions {
  /** Supplied only by an operator who reached an authorized real endpoint + budget. */
  readonly realModel?: RealModelRun
  readonly now?: () => string
}

/**
 * Run the fixed set in controlled/loopback mode and build the readiness report. Real-model
 * quality is supplied separately through `realModel`; with no such run it is `not_verified`.
 */
export async function runModellingParameterEvaluation(
  set: readonly ModellingParameterCase[] = MODELLING_PARAMETER_EVAL_SET,
  options: ModellingParameterEvaluationOptions = {},
): Promise<ModellingParameterEvaluationResult> {
  const setDigest = sha256DigestOf(canonicalJson(evalSetProjection(set)))
  const cases: CaseEvaluation[] = []
  let passed = 0
  for (const entry of set) {
    const evaluation =
      entry.family === 'modelling' ? await evaluateModellingCase(entry) : await evaluateParameterCase(entry)
    cases.push(evaluation)
    if (evaluationMatchesExpected(evaluation, entry.expected)) passed += 1
  }
  const controlled = buildControlledVerification(setDigest, cases, passed)
  const report = buildReadinessReport({
    setDigest,
    controlled,
    ...(options.realModel === undefined ? {} : { realModel: options.realModel }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { setDigest, cases, controlled, report }
}

export { evalSetProjection }
export type { ModellingEvalCase, ParameterEvalCase, ModellingParameterCase } from './fixed-set'
