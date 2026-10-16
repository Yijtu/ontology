import { describe, expect, it } from 'vitest'
import {
  AUTHORING_COMMAND_KINDS,
  COMMAND_RECEIPT_STATUSES,
  PUBLIC_DATA_TOOL_IDS,
  agentActionKindOf,
  assertAgentActionShape,
  assertCommandCallShape,
  assertCommandReceiptShape,
  assertResearchExecutionAnyShape,
  assertResearchExecutionShape,
  assertResearchExecutionV2Shape,
  assertResearchRunManifestShape,
  assertResearchPreflightShape,
  assertSubmitCandidatesCommandShape,
  assertSubmitCandidatesReceiptShape,
  assertWebSearchToolOutputShape,
  assertDocumentTargetedReadRequestShape,
  assertDocumentTargetedReadResultShape,
  findForbiddenModelFields,
  isAgentAction,
  isCommandCall,
  isResearchExecutionV2,
  researchExecutionSchemaVersion,
  toWebSearchToolPage,
  type WebSearchProviderPage,
} from '@ontology/contracts'

const WORKSPACE = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DIGEST = `sha256:${'a'.repeat(64)}`

const resourceRef = { id: WORKSPACE, version: '1.0.0', digest: DIGEST, kind: 'artifact' as const }
const documentRef = { id: '22222222-3333-4444-8555-666666666666', version: '1.0.0', digest: DIGEST, kind: 'document' }
const versionRef = { id: 'policy', version: '1.0.0', digest: DIGEST }

const webEvidence = {
  kind: 'web_page',
  url: 'https://example.com/standard',
  snapshotRef: resourceRef,
  snapshotManifestRef: resourceRef,
  contentDigest: DIGEST,
  fetchedAt: '2026-10-16T00:00:00Z',
  parserVersion: '1.0.0',
}
const locatedEvidence = {
  kind: 'located_span',
  sourceRef: documentRef,
  span: {
    kind: 'text',
    parseId: WORKSPACE,
    chunkId: '44444444-5555-4666-8777-888888888888',
    locator: { kind: 'page', page: 3 },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: DIGEST,
    textDigest: DIGEST,
  },
  parserVersion: '1.0.0',
}

const sourceSubmission = {
  kind: 'source',
  origin: { url: 'https://example.com/standard', publisher: 'Example' },
  evidence: [webEvidence],
  reason: '疑似官方规范，待人工审核',
}
const definitionSubmission = {
  kind: 'definition',
  definitionKind: 'object',
  payload: {
    kind: 'object',
    logicalId: 'CableTray',
    displayName: '桥架',
    businessMeaning: '承载电缆的支撑结构',
    suggestedReason: '规范中反复出现',
    identityAttributeIds: ['CableTray.code'],
  },
  evidence: [webEvidence, locatedEvidence],
  reason: '由规范原文支撑',
}
const ruleSubmission = {
  kind: 'rule',
  payload: {
    ruleId: 'stop-condition',
    applicability: { objectId: 'CableTray' },
    condition: { op: 'compare', attributeId: 'CableTray.temp', operator: 'gte', value: 70, spans: [] },
    exceptions: [],
    ruleDependencies: [],
  },
  evidence: [webEvidence],
  reason: '规范给出停机温度阈值',
}
const actionSubmission = {
  kind: 'action',
  declaration: {
    actionId: 'inspect',
    displayName: '点检',
    businessMeaning: '按周期点检',
    suggestedReason: '规范要求',
    inputSchemaRef: versionRef,
    outputSchemaRef: versionRef,
    preconditions: [],
    requiredCapabilities: [],
    permissions: [],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: [],
  },
  evidence: [webEvidence],
  reason: '规范要求点检',
}

const validCommand = {
  schemaVersion: 'submit-candidates@1',
  commandKind: 'submit_candidates',
  workspaceId: WORKSPACE,
  candidates: [sourceSubmission, definitionSubmission, ruleSubmission, actionSubmission],
  note: '疑似官方规范',
}

describe('runtime action union keeps the four-tool catalogue closed', () => {
  it('exposes exactly the four public data tools and never submit_candidates', () => {
    expect(PUBLIC_DATA_TOOL_IDS).toEqual([
      'ontology_lookup',
      'data_query',
      'document_search',
      'web_search',
    ])
    expect(PUBLIC_DATA_TOOL_IDS).not.toContain('submit_candidates')
  })

  it('accepts a data tool action for each of the four tools', () => {
    for (const toolId of PUBLIC_DATA_TOOL_IDS) {
      const action = { kind: 'data_tool', call: { callId: RUN, toolId, arguments: {} } }
      expect(() => assertAgentActionShape(action)).not.toThrow()
      expect(isAgentAction(action)).toBe(true)
      expect(agentActionKindOf(action)).toBe('data_tool')
    }
  })

  it('rejects a data tool action for an unregistered or write tool id', () => {
    expect(isAgentAction({ kind: 'data_tool', call: { callId: RUN, toolId: 'submit_candidates', arguments: {} } })).toBe(false)
    expect(isAgentAction({ kind: 'data_tool', call: { callId: RUN, toolId: 'execute_sql', arguments: {} } })).toBe(false)
    expect(agentActionKindOf({ kind: 'other' })).toBeUndefined()
  })

  it('routes submit_candidates through the authoring command branch only', () => {
    const action = { kind: 'authoring_command', command: validCommand }
    expect(() => assertAgentActionShape(action)).not.toThrow()
    expect(agentActionKindOf(action)).toBe('authoring_command')
  })
})

describe('submit_candidates@1 accepts evidence and fixes authority server-side', () => {
  it('accepts source/definition/rule/action candidates, each with one or more evidence items', () => {
    expect(() => assertSubmitCandidatesCommandShape(validCommand)).not.toThrow()
    const singleEvidence = { ...validCommand, candidates: [sourceSubmission] }
    expect(() => assertSubmitCandidatesCommandShape(singleEvidence)).not.toThrow()
  })

  it('rejects a candidate with no evidence', () => {
    const noEvidence = { ...validCommand, candidates: [{ ...sourceSubmission, evidence: [] }] }
    expect(() => assertSubmitCandidatesCommandShape(noEvidence)).toThrow(/evidence/i)
  })

  it('rejects model-forged identity, review, publication and trust fields', () => {
    for (const forbidden of [
      { ...sourceSubmission, trustTier: 'public_standard' },
      { ...sourceSubmission, sourceId: WORKSPACE },
      { ...sourceSubmission, reviewState: 'approved' },
      { ...sourceSubmission, publishedAt: '2026-10-16T00:00:00Z' },
      { ...sourceSubmission, confidence: 0.92 },
      { ...sourceSubmission, runId: RUN },
    ]) {
      const command = { ...validCommand, candidates: [forbidden] }
      expect(() => assertSubmitCandidatesCommandShape(command)).toThrow()
    }
    expect(findForbiddenModelFields([{ trustTier: 'x' }])).toEqual([{ path: 'candidates[0].trustTier', field: 'trustTier' }])
  })

  it('rejects an unknown candidate kind and an oversized candidate list', () => {
    expect(() => assertSubmitCandidatesCommandShape({ ...validCommand, candidates: [{ kind: 'entity' }] })).toThrow()
    expect(() => assertSubmitCandidatesCommandShape({ ...validCommand, candidates: [] })).toThrow()
  })

  it('validates a receipt and rejects a malformed one', () => {
    const receipt = {
      schemaVersion: 'submit-candidates-receipt@1',
      runId: RUN,
      workspaceId: WORKSPACE,
      commandDigest: DIGEST,
      accepted: [{
        submissionIndex: 0,
        candidateId: WORKSPACE,
        kind: 'definition',
        state: 'pending_confirmation',
        pendingConfirmation: true,
        issues: [],
        sourceRefs: [resourceRef],
      }],
      rejected: [{ submissionIndex: 1, code: 'EVIDENCE_NOT_AUTHORIZED', message: 'not this run' }],
      replayed: false,
      recordedAt: '2026-10-16T00:00:00Z',
    }
    expect(() => assertSubmitCandidatesReceiptShape(receipt)).not.toThrow()
    expect(() => assertSubmitCandidatesReceiptShape({ ...receipt, accepted: [{ submissionIndex: 0 }] })).toThrow()
  })
})

describe('research-execution@2 is a run projection and @1 stays readable', () => {
  const limits = { sourceLimit: 40, candidateLimit: 60, deadline: '2026-10-16T00:00:00Z' }
  const coverage = {
    queriesPlanned: 3, searchCalls: 2, pagesDiscovered: 9, archivedSnapshots: 6,
    skippedWithoutSnapshot: 3, excludedCount: 0, failedCount: 0, truncated: false,
  }
  const v1 = {
    schemaVersion: 'research-execution@1',
    researchId: WORKSPACE,
    workspaceId: WORKSPACE,
    jobId: RUN,
    status: 'running',
    stage: 'searching',
    briefRef: resourceRef,
    policyRef: versionRef,
    budgetRef: versionRef,
    limits,
    coverage,
    sourceCount: 6,
    candidateCount: 0,
    recordedAt: '2026-10-16T00:00:00Z',
  }
  const v2 = {
    schemaVersion: 'research-execution@2',
    researchId: WORKSPACE,
    workspaceId: WORKSPACE,
    runId: RUN,
    goal: { kind: 'industry_workspace_research', workspaceId: WORKSPACE, draftRevision: '3' },
    status: 'running',
    stage: 'searching',
    briefRef: resourceRef,
    policyRef: versionRef,
    budgetRef: versionRef,
    budget: {
      maxTotalCalls: 100, maxSearchCalls: 20, maxModelTokens: 100000, maxModelTurns: 30,
      maxSources: 40, maxCandidates: 60, maxDownloadBytes: 1048576, maxReadBytes: 2097152,
      maxConcurrency: 2, maxRepairAttempts: 4, deadline: '2026-10-16T00:00:00Z',
    },
    limits,
    coverage,
    coverageGaps: [{ kind: 'must_cover', name: '停机条件版本', state: 'pending_confirmation', evidenceCount: 2 }],
    humanTodos: [{ todoId: RUN, kind: 'source_review', message: '待审核来源', createdAt: '2026-10-16T00:00:00Z' }],
    evidence: [{ sourceRef: documentRef, locatorKind: 'document_span', digest: DIGEST, archived: true }],
    candidateReceipts: [{ candidateId: WORKSPACE, kind: 'definition', state: 'pending_confirmation', pendingConfirmation: true, issueCodes: ['SOURCE_TRUST_BLOCKED'] }],
    sourceCount: 6,
    candidateCount: 3,
    usage: {
      searchCalls: 2, archivedSnapshots: 6, modelTokens: 5000, modelTurns: 4, candidatesSubmitted: 3,
      bytesDownloaded: 50000, bytesRead: 12000, repairAttempts: 0, usageUnknown: false,
    },
    recordedAt: '2026-10-16T00:00:00Z',
  }

  it('reads a legacy @1 record unchanged through the shared validator', () => {
    expect(() => assertResearchExecutionShape(v1)).not.toThrow()
    expect(() => assertResearchExecutionAnyShape(v1)).not.toThrow()
    expect(researchExecutionSchemaVersion(v1)).toBe('research-execution@1')
    expect(isResearchExecutionV2(v1)).toBe(false)
  })

  it('validates @2 with goal, gaps, todos, evidence, receipts and budget', () => {
    expect(() => assertResearchExecutionV2Shape(v2)).not.toThrow()
    expect(() => assertResearchExecutionAnyShape(v2)).not.toThrow()
    expect(researchExecutionSchemaVersion(v2)).toBe('research-execution@2')
    expect(isResearchExecutionV2(v2)).toBe(true)
  })

  it('rejects a @2 with an unknown goal, gap state or missing budget dimension', () => {
    expect(() => assertResearchExecutionV2Shape({ ...v2, goal: { kind: 'freeform' } })).toThrow()
    expect(() => assertResearchExecutionV2Shape({ ...v2, coverageGaps: [{ kind: 'x', name: 'y', state: 'maybe', evidenceCount: 0 }] })).toThrow()
    const budget: Record<string, unknown> = { ...v2.budget }
    delete budget['maxReadBytes']
    expect(() => assertResearchExecutionV2Shape({ ...v2, budget })).toThrow()
  })

  it('validates a research run manifest whose purpose matches its goal kind', () => {
    const manifest = {
      schemaVersion: 'research-run-manifest@1',
      runId: RUN,
      purpose: 'industry_workspace_research',
      goal: v2.goal,
      briefRef: resourceRef,
      runtimeRef: versionRef,
      modelBindingRef: resourceRef,
      toolBindingRefs: [resourceRef],
      authorizationReceiptRef: resourceRef,
      budgetLedgerId: WORKSPACE,
      inputManifestId: WORKSPACE,
      createdAt: '2026-10-16T00:00:00Z',
    }
    expect(() => assertResearchRunManifestShape(manifest)).not.toThrow()
    expect(() => assertResearchRunManifestShape({ ...manifest, purpose: 'project_qa' })).toThrow()
  })
})

describe('authoring command call/receipt keeps the write separate from the four data tools', () => {
  const call = {
    commandKind: 'submit_candidates',
    callId: RUN,
    command: validCommand,
  }
  const receipt = {
    callId: RUN,
    commandKind: 'submit_candidates',
    status: 'accepted',
    candidateIds: [WORKSPACE],
    issueCodes: [],
    receiptDigest: DIGEST,
    recordedAt: '2026-10-16T00:00:00Z',
  }

  it('exposes exactly submit_candidates and the four receipt statuses', () => {
    expect(AUTHORING_COMMAND_KINDS).toEqual(['submit_candidates'])
    expect(COMMAND_RECEIPT_STATUSES).toEqual(['accepted', 'rejected', 'pending_confirmation', 'deferred'])
  })

  it('validates a well-formed command call and rejects an unknown kind or a malformed body', () => {
    expect(() => assertCommandCallShape(call)).not.toThrow()
    expect(isCommandCall(call)).toBe(true)
    expect(isCommandCall({ ...call, commandKind: 'delete_everything' })).toBe(false)
    expect(isCommandCall({ ...call, command: { schemaVersion: 'submit-candidates@1' } })).toBe(false)
  })

  it('validates a receipt and rejects a malformed one', () => {
    expect(() => assertCommandReceiptShape(receipt)).not.toThrow()
    expect(() => assertCommandReceiptShape({ ...receipt, status: 'maybe' })).toThrow()
    expect(() => assertCommandReceiptShape({ ...receipt, receiptDigest: 'not-a-digest' })).toThrow()
  })
})

describe('web_search results separate archived from discovery-only', () => {
  const basePage: WebSearchProviderPage = {
    url: 'https://example.com/a',
    title: 'A',
    snippet: 'snippet',
    fetchedAt: '2026-10-16T00:00:00Z',
    contentDigest: DIGEST,
    snapshotRef: resourceRef,
    snapshotManifestRef: resourceRef,
  }

  it('maps a snapshot-backed page to archived and a link-only page to discovery_only', () => {
    const archived = toWebSearchToolPage(basePage, '1.0.0')
    expect(archived.discovery).toBe('archived')
    const linkOnly = toWebSearchToolPage(
      { url: 'https://example.com/a', title: 'A', snippet: 'snippet', fetchedAt: '2026-10-16T00:00:00Z', contentDigest: DIGEST, snapshotUnavailableReason: 'fetch_timeout' },
      '1.0.0',
    )
    expect(linkOnly.discovery).toBe('discovery_only')
    expect(assertWebSearchToolOutputShape({ pages: [archived, linkOnly] })).toBeUndefined()
  })

  it('rejects an archived page without a snapshot and a discovery-only page without a reason', () => {
    expect(() => assertWebSearchToolOutputShape({ pages: [{ discovery: 'archived', url: 'https://x.test/a', title: 't', snippet: '', contentDigest: DIGEST, parserVersion: '1.0.0' }] })).toThrow()
    expect(() => assertWebSearchToolOutputShape({ pages: [{ discovery: 'discovery_only', url: 'https://x.test/a', title: 't', snippet: '', contentDigest: DIGEST }] })).toThrow()
  })
})

describe('document_search targeted read is versioned and bounded', () => {
  const request = {
    schemaVersion: 'document-targeted-read@1',
    workspaceId: WORKSPACE,
    selections: [{ documentRef, locator: { kind: 'page', page: 1 }, parseId: WORKSPACE }],
    maxBytes: 65536,
    limit: 8,
  }

  it('accepts a bounded targeted-read request and result', () => {
    expect(() => assertDocumentTargetedReadRequestShape(request)).not.toThrow()
    const result = {
      schemaVersion: 'document-targeted-read-result@1',
      items: [{
        documentRef,
        locator: { kind: 'page', page: 1 },
        parserVersion: '1.0.0',
        quoteDigest: DIGEST,
        textDigest: DIGEST,
        text: 'readable preview',
        truncated: false,
        indexState: 'indexed',
      }],
      truncated: false,
      usage: { bytes: 16, documents: 1 },
    }
    expect(() => assertDocumentTargetedReadResultShape(result)).not.toThrow()
  })

  it('rejects an empty or oversized selection list and an unknown index state', () => {
    expect(() => assertDocumentTargetedReadRequestShape({ ...request, selections: [] })).toThrow()
    expect(() => assertDocumentTargetedReadRequestShape({ ...request, limit: 65 })).toThrow()
    expect(() => assertDocumentTargetedReadResultShape({
      schemaVersion: 'document-targeted-read-result@1',
      items: [{ documentRef, locator: { kind: 'page' }, parserVersion: '1.0.0', quoteDigest: DIGEST, textDigest: DIGEST, text: '', truncated: false, indexState: 'maybe' }],
      truncated: false,
      usage: { bytes: 0, documents: 0 },
    })).toThrow()
  })
})

describe('ResearchPreflight (design §2/§10)', () => {
  const preflight = {
    schemaVersion: 'research-preflight@1' as const,
    workspaceId: WORKSPACE,
    generatedAt: '2026-10-16T00:00:00Z',
    recipient: { state: 'available' as const, toolId: 'web_search' as const, connectionId: RUN, connectionName: '兼容网关', adapterType: 'http_compat' as const, connectionRevision: '3' },
    requestedDomains: ['example.com'],
    effectiveDomains: ['example.com'],
    limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2026-10-16T01:00:00Z' },
    policyRef: versionRef,
    budgetRef: versionRef,
    blocked: [],
    authorization: { roles: ['researcher'], deadline: '2026-10-16T01:00:00Z', note: '只读预检' },
  }

  it('accepts an available and a blocked preflight', () => {
    expect(() => assertResearchPreflightShape(preflight)).not.toThrow()
    expect(() => assertResearchPreflightShape({ ...preflight, recipient: { state: 'blocked', toolId: 'web_search', blockedReason: 'CREDENTIAL_MISSING' }, blocked: [{ code: 'CREDENTIAL_MISSING', message: '缺凭据' }] })).not.toThrow()
  })

  it('rejects a wrong schema version, a bad recipient state and a credential-shaped reply', () => {
    expect(() => assertResearchPreflightShape({ ...preflight, schemaVersion: 'research-preflight@2' })).toThrow()
    expect(() => assertResearchPreflightShape({ ...preflight, recipient: { state: 'ready', toolId: 'web_search' } })).toThrow()
    expect(() => assertResearchPreflightShape({ ...preflight, recipient: { ...preflight.recipient, apiKey: 'tvly' } })).toThrow(/credential/i)
  })
})
