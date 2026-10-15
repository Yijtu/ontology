import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertCandidateSourceReviewCommandShape,
  assertCandidateSourceShape,
  assertEffectiveModelSelectionShape,
  assertExecutionModelBindingShape,
  assertModelAssignmentSetShape,
  assertModelConnectionDescriptorShape,
  assertModelConnectionSummaryShape,
  assertModelConnectionTestResultShape,
  assertModelingBriefShape,
  assertResearchExecutionShape,
  assertResearchRequestShape,
  assertSourceCapabilityProjectionShape,
  assertWorkbenchOverviewShape,
  modelAdapterSupportsCapability,
  type CandidateSourceReviewCommand,
  type EffectiveModelSelection,
  type ExecutionModelBinding,
  type ModelAssignmentSet,
  type ModelConnectionSummary,
  type ModelTargetScope,
  type ResearchRequest,
  type ResourceRef,
  type WorkbenchOverview,
} from '@ontology/contracts'

/**
 * N01: the source/research/overview/model-selection contracts added by the knowledge-workbench
 * design (§2.1, §5.3). Every shape is validated at runtime, old requests stay readable, and no
 * contract may carry a credential value.
 */

const WORKSPACE = '00000000-0000-4000-8000-000000000002'
const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const resourceRef: ResourceRef = { id: '00000000-0000-4000-8000-000000000003', version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const versionRef = { id: 'policy.research', version: '1.0.0', digest: DIGEST }

function candidateSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'candidate-source@1',
    sourceId: '00000000-0000-4000-8000-000000000001',
    workspaceId: WORKSPACE,
    kind: 'web_fetch',
    trustTier: 'agent_researched',
    origin: { url: 'https://example.org/standard' },
    contentRef: resourceRef,
    contentDigest: DIGEST_B,
    reviewState: 'proposed',
    proposedBy: 'researcher',
    recordedAt: '2026-10-15T00:00:00Z',
    ...overrides,
  }
}

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'modeling-brief@1',
    workspaceId: WORKSPACE,
    goal: '按 GB50500 建桥架计价本体',
    allowedResearchDomains: ['standards.example.org'],
    targetKinds: ['object', 'attribute'],
    ...overrides,
  }
}

describe('N01 candidate source review (append-only, versioned command)', () => {
  it('keeps a legacy candidate-source@1 proposal readable', () => {
    expect(() => assertCandidateSourceShape(candidateSource())).not.toThrow()
  })

  it('accepts the new title/research association/review refs and rejects a malformed one', () => {
    expect(() => assertCandidateSourceShape(candidateSource({
      title: '设备维护规范',
      researchRunId: '00000000-0000-4000-8000-00000000000a',
      reviewRecordRefs: [resourceRef],
    }))).not.toThrow()
    expect(() => assertCandidateSourceShape(candidateSource({ researchRunId: 'not-a-uuid' }))).toThrow()
    expect(() => assertCandidateSourceShape(candidateSource({ reviewRecordRefs: [resourceRef, resourceRef] }))).toThrow()
  })

  it('validates the review command and requires a workspace, reason, revision and basis refs', () => {
    const command: CandidateSourceReviewCommand = {
      schemaVersion: 'candidate-source-review@1',
      sourceId: '00000000-0000-4000-8000-000000000001',
      workspaceId: WORKSPACE,
      reviewState: 'approved',
      trustTier: 'public_standard',
      reviewedBy: 'expert',
      reason: 'GB standard confirmed',
      expectedRevision: '1',
      basisRefs: [resourceRef],
      idempotencyKey: 'cmd-key-0001',
    }
    expect(() => assertCandidateSourceReviewCommandShape(command)).not.toThrow()
    expect(() => assertCandidateSourceReviewCommandShape({ ...command, workspaceId: 'x' })).toThrow()
    expect(() => assertCandidateSourceReviewCommandShape({ ...command, reason: '' })).toThrow()
    expect(() => assertCandidateSourceReviewCommandShape({ ...command, expectedRevision: 'r1' })).toThrow()
  })
})

describe('N01 research request separates source count from candidate count', () => {
  it('accepts the versioned request and brief extensions, and rejects a swallowed count', () => {
    const request: ResearchRequest = {
      schemaVersion: 'research-request@1',
      workspaceId: WORKSPACE,
      brief: {
        schemaVersion: 'modeling-brief@1',
        workspaceId: WORKSPACE,
        goal: '设备维护规则',
        allowedResearchDomains: ['standards.example.org'],
        targetKinds: ['object'],
        standardVersions: [{ standardId: 'GB', revision: '50500-2013', title: '计价规范' }],
        granularity: 'standard',
        namingConvention: { caseStyle: 'pascal_case', locale: 'zh-CN' },
        sourceLimit: 20,
        candidateLimit: 50,
      },
      limits: { sourceLimit: 20, candidateLimit: 50, deadline: '2026-10-16T00:00:00Z' },
      allowedDomains: ['standards.example.org'],
      policyRef: versionRef,
      budgetRef: versionRef,
      idempotencyKey: 'research-key-0001',
    }
    expect(() => assertModelingBriefShape(request.brief)).not.toThrow()
    expect(() => assertResearchRequestShape(request)).not.toThrow()
    expect(() => assertResearchRequestShape({ ...request, limits: { sourceLimit: 0, candidateLimit: 50, deadline: request.limits.deadline } })).toThrow()
    expect(() => assertModelingBriefShape(brief({ sourceLimit: 500 }))).toThrow()
  })

  it('validates a research execution with both counts and a known stop reason', () => {
    const execution = {
      schemaVersion: 'research-execution@1',
      researchId: '00000000-0000-4000-8000-000000000010',
      workspaceId: WORKSPACE,
      jobId: '00000000-0000-4000-8000-000000000011',
      status: 'awaiting_confirmation',
      stage: 'awaiting_source_review',
      briefRef: resourceRef,
      policyRef: versionRef,
      budgetRef: versionRef,
      limits: { sourceLimit: 20, candidateLimit: 50, deadline: '2026-10-16T00:00:00Z' },
      coverage: { queriesPlanned: 3, searchCalls: 3, pagesDiscovered: 18, archivedSnapshots: 15, skippedWithoutSnapshot: 3, excludedCount: 0, failedCount: 0, truncated: false },
      sourceCount: 15,
      candidateCount: 0,
      recordedAt: '2026-10-15T00:00:00Z',
    }
    expect(() => assertResearchExecutionShape(execution)).not.toThrow()
    expect(() => assertResearchExecutionShape({ ...execution, stopReason: 'surprise' })).toThrow()
    expect(() => assertResearchExecutionShape({ ...execution, coverage: { ...execution.coverage, truncated: 'no' } })).toThrow()
  })
})

describe('N01 workbench overview and source capability projections', () => {
  it('validates a fixed-revision overview and rejects an unusable capability without a reason', () => {
    const overview: WorkbenchOverview = {
      schemaVersion: 'workbench-overview@1',
      scopeRef: { tenantId: '00000000-0000-4000-8000-0000000000aa', spaceId: '00000000-0000-4000-8000-0000000000bb' },
      subject: { kind: 'industry_workspace', workspaceId: WORKSPACE, revision: '12' },
      revision: '12',
      digest: DIGEST,
      summary: '设备维护知识建设',
      counts: { proposedSources: 3, approvedSourcesNotAdmitted: 0, candidatesPendingReview: 2, recordsPendingConfirmation: 0, blockedTasks: 0 },
      nextSteps: [{ action: 'confirm_sources', label: '确认调研来源', reason: '3 个调研来源待确认' }],
      blockers: [],
      capabilities: [
        { ability: 'generation', available: true },
        { ability: 'research', available: false, unavailableReason: '未配置搜索服务' },
      ],
      asOf: '2026-10-15T00:00:00Z',
    }
    expect(() => assertWorkbenchOverviewShape(overview)).not.toThrow()
    expect(() => assertWorkbenchOverviewShape({ ...overview, capabilities: [{ ability: 'research', available: false }] })).toThrow()
    expect(() => assertWorkbenchOverviewShape({ ...overview, subject: { kind: 'industry_workspace', workspaceId: WORKSPACE } })).toThrow()
  })

  it('validates the source capability projection', () => {
    expect(() => assertSourceCapabilityProjectionShape({
      schemaVersion: 'source-capability-projection@1',
      scopeRef: { tenantId: '00000000-0000-4000-8000-0000000000aa', spaceId: '00000000-0000-4000-8000-0000000000bb' },
      entries: [
        { entry: 'upload', displayName: '上传或粘贴资料', supportedFormats: ['text/csv', 'xlsx'], maxBytes: 10_485_760, maxRows: 100_000, canResearch: false, canArchive: true, canGenerate: true },
        { entry: 'structured_file', displayName: '文件映射', supportedFormats: ['text/csv'], canResearch: false, canArchive: false, canGenerate: false, unavailableReason: '尚未接入文件映射' },
      ],
      asOf: '2026-10-15T00:00:00Z',
    })).not.toThrow()
    expect(() => assertSourceCapabilityProjectionShape({
      schemaVersion: 'source-capability-projection@1',
      scopeRef: { tenantId: 'x', spaceId: 'y' },
      entries: [],
      asOf: '2026-10-15T00:00:00Z',
    })).toThrow()
  })
})

describe('N01 model selection contracts', () => {
  const summary: ModelConnectionSummary = {
    connectionId: '00000000-0000-4000-8000-000000000020',
    name: '公司生成模型',
    revision: '1',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation', 'research'],
    enabled: true,
    credentialState: 'present',
    updatedAt: '2026-10-15T00:00:00Z',
  }

  it('rejects any credential-shaped field on a connection summary', () => {
    expect(() => assertModelConnectionSummaryShape(summary)).not.toThrow()
    expect(() => assertModelConnectionSummaryShape({ ...summary, apiKey: 'should-never-appear' })).toThrow()
  })

  it('encodes the adapter/capability rule: generation cannot be JEV, and vice versa', () => {
    expect(modelAdapterSupportsCapability('company_generation', 'generation')).toBe(true)
    expect(modelAdapterSupportsCapability('company_generation', 'research')).toBe(true)
    expect(modelAdapterSupportsCapability('company_generation', 'decision_jev')).toBe(false)
    expect(modelAdapterSupportsCapability('jev', 'decision_jev')).toBe(true)
    expect(modelAdapterSupportsCapability('jev', 'generation')).toBe(false)
    expect(() => assertModelConnectionDescriptorShape({
      name: 'x', adapterType: 'company_generation', protocol: 'openai_compatible', capabilities: ['decision_jev'],
      enabled: true, platformModelId: 'p', providerModelName: 'v',
    })).toThrow()
  })

  it('validates a target scope discriminated union, assignments and the effective selection', () => {
    const scope: ModelTargetScope = { kind: 'industry_workspace', workspaceId: WORKSPACE }
    const assignment: ModelAssignmentSet = {
      schemaVersion: 'model-assignment-set@1',
      scope,
      defaultSelection: { kind: 'connection', connectionId: summary.connectionId },
      capabilitySelections: [{ capability: 'decision_jev', selection: { kind: 'disabled' } }],
      revision: '3',
      updatedAt: '2026-10-15T00:00:00Z',
    }
    expect(() => assertModelAssignmentSetShape(assignment)).not.toThrow()
    expect(() => assertModelAssignmentSetShape({ ...assignment, defaultSelection: { kind: 'connection' } })).toThrow()
    expect(() => assertModelAssignmentSetShape({ ...assignment, capabilitySelections: [
      { capability: 'generation', selection: { kind: 'inherit' } },
      { capability: 'generation', selection: { kind: 'inherit' } },
    ] })).toThrow()

    const effective: EffectiveModelSelection = {
      schemaVersion: 'effective-model-selection@1',
      scope,
      capability: 'generation',
      selection: { kind: 'connection', connectionId: summary.connectionId },
      resolvedFrom: 'space_default',
      state: 'available',
      connectionId: summary.connectionId,
      connectionSummary: summary,
      resolvedAt: '2026-10-15T00:00:00Z',
    }
    expect(() => assertEffectiveModelSelectionShape(effective)).not.toThrow()
    expect(() => assertEffectiveModelSelectionShape({ ...effective, state: 'available', connectionId: undefined })).toThrow()
    expect(() => assertEffectiveModelSelectionShape({ ...effective, blockedReason: 'UNKNOWN' })).toThrow()
  })

  it('validates the execution binding and the probe result without leaking secrets', () => {
    const binding: ExecutionModelBinding = {
      schemaVersion: 'execution-model-binding@1',
      executionId: '00000000-0000-4000-8000-000000000030',
      capability: 'generation',
      connectionId: summary.connectionId,
      connectionRevision: '1',
      modelRef: { modelId: 'company-generation', version: '1.0.0' },
      componentRef: { id: 'component.generation', version: '1.0.0', digest: DIGEST },
      assignmentRevision: '3',
      resolvedFrom: 'space_default',
      boundAt: '2026-10-15T00:00:00Z',
    }
    expect(() => assertExecutionModelBindingShape(binding)).not.toThrow()
    expect(() => assertExecutionModelBindingShape({ ...binding, apiKey: 'leak' })).toThrow()
    expect(() => assertModelConnectionTestResultShape({
      schemaVersion: 'model-connection-test-result@1',
      connectionId: summary.connectionId,
      connectionRevision: '1',
      status: 'failed',
      testedAt: '2026-10-15T00:00:00Z',
      reason: 'authentication_failed',
      draft: false,
      credentialConfigured: true,
    })).not.toThrow()
    expect(() => assertModelConnectionTestResultShape({
      schemaVersion: 'model-connection-test-result@1', status: 'maybe', testedAt: '2026-10-15T00:00:00Z', draft: false, credentialConfigured: false,
    })).toThrow()
  })
})

describe('N01 contracts stay additive over the existing public surface', () => {
  it('keeps the legacy brief and research candidate limit configurable independently', () => {
    expectTypeOf<ResearchRequest['limits']>().toHaveProperty('sourceLimit')
    expectTypeOf<ResearchRequest['limits']>().toHaveProperty('candidateLimit')
  })
})
