import { randomUUID } from 'node:crypto'
import { contentDigestOf } from '@ontology/application'
import { isRecord, isResourceRef, isVersionRef } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, VersionRef } from '@ontology/contracts'

export type GenericOrCall = (
  path: string,
  body?: unknown,
  revision?: string,
) => Promise<Record<string, unknown>>

export interface PreparedOrSource {
  readonly sourceRef: ResourceRef
  readonly policyText: string
  readonly generationPolicyRef: VersionRef
}

export interface PreparedOrCompetency {
  readonly competencyQuestionRef: VersionRef
  readonly definitionRef: VersionRef
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} was not a nonempty string`)
  return value
}

function actualVersionRef(value: unknown, label: string): VersionRef {
  if (!isVersionRef(value)) throw new Error(`${label} was not an actual version reference`)
  // Resource refs returned by authoring context can carry `kind`; the generation request is
  // deliberately the closed VersionRef shape accepted by the route.
  return { id: value.id, version: value.version, digest: value.digest }
}

function actualResourceRef(value: unknown, label: string): ResourceRef {
  if (!isResourceRef(value)) throw new Error(`${label} was not an actual resource reference`)
  return value
}

async function workspaceHead(call: GenericOrCall, workspaceId: string): Promise<string> {
  const workspaceView = await call(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`)
  const workspace = object(workspaceView['workspace'], 'industry workspace')
  return text(workspace['headRevision'], 'industry workspace head revision')
}

function uniqueRefs(refs: readonly VersionRef[]): readonly VersionRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.id}\u0000${ref.version}\u0000${ref.digest}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Uploads a real, scope-bound source and reads the generation policy from the registered workspace. */
export async function prepareOrSource(input: {
  readonly workspaceId: string
  readonly call: GenericOrCall
}): Promise<PreparedOrSource> {
  const policyText = [
    'The asset_code field identifies an asset in the approved registry.',
    "The reviewed inspection rule has two different OR conditions: asset_code = 'asset-code-1' or inspection_due = true.",
    'inspection_required names the rule conclusion; it is not asserted by this applicability fixture.',
  ].join(' ')
  const upload = await input.call(`/api/v1/core/workspaces/${encodeURIComponent(input.workspaceId)}/sources`, {
    name: 'generic-or-source.txt',
    mediaType: 'text/plain',
    contentEncoding: 'base64',
    content: Buffer.from(policyText, 'utf8').toString('base64'),
  }, await workspaceHead(input.call, input.workspaceId))
  const source = object(upload['source'], 'actual Core workspace source')
  const sourceRef = actualResourceRef(source['sourceRef'], 'uploaded policy source reference')
  const sourceGrounding = await input.call(`/api/v1/industry-workspaces/${encodeURIComponent(input.workspaceId)}/source-grounding`, {
    sourceRefs: [sourceRef],
  }, await workspaceHead(input.call, input.workspaceId))
  const fragments = sourceGrounding['fragments']
  if (!Array.isArray(fragments) || fragments.length === 0) throw new Error('uploaded OR policy source returned no actual source-grounding fragments')
  const firstFragment = object(fragments[0], 'first policy source fragment')
  const firstFragmentSource = actualResourceRef(firstFragment['sourceRef'], 'first policy fragment source pin')
  const firstFragmentText = text(firstFragment['text'], 'first policy source fragment text')
  if (firstFragment['sourceIndex'] !== 0 || firstFragment['fragmentIndex'] !== 0 || firstFragmentSource.id !== sourceRef.id ||
    !firstFragmentText.includes("asset_code = 'asset-code-1'") || !firstFragmentText.includes('inspection_due = true')) {
    throw new Error('actual source-grounding fragment 0/0 does not contain both reviewed OR conditions')
  }
  const authoring = await input.call(`/api/v1/core/workspaces/${encodeURIComponent(input.workspaceId)}/authoring-context`)
  const generationPolicyRef = actualVersionRef(authoring['generationPolicyRef'], 'registered generation policy')
  return { sourceRef, policyText, generationPolicyRef }
}

/** Confirms the actual current definition heads against an uploaded source, then approves each replacement. */
export async function confirmOrDefinitions(input: {
  readonly workspaceId: string
  readonly candidateIds: readonly string[]
  readonly sourceRef: ResourceRef
  readonly call: GenericOrCall
}): Promise<readonly string[]> {
  if (input.candidateIds.length === 0 || new Set(input.candidateIds).size !== input.candidateIds.length) {
    throw new Error('source confirmation requires unique actual candidate IDs')
  }
  const inventory = await input.call(`/api/v1/industry-workspaces/${encodeURIComponent(input.workspaceId)}/candidates`)
  const candidatesValue = inventory['candidates']
  if (!Array.isArray(candidatesValue)) throw new Error('the current definition candidate inventory was missing')
  const heads = input.candidateIds.map((candidateId) => {
    const candidate = candidatesValue.map((value) => object(value, 'definition candidate'))
      .find((entry) => entry['candidateId'] === candidateId)
    if (candidate === undefined) throw new Error(`current candidate ${candidateId} was not returned by the workspace inventory`)
    if (candidate['pendingConfirmation'] !== true) throw new Error(`current candidate ${candidateId} does not require source confirmation`)
    return { candidateId, contentDigest: text(candidate['contentDigest'], `candidate ${candidateId} content digest`) }
  })
  const confirmedCandidateIds: string[] = []
  for (const head of heads) {
    const confirmed = await input.call(
      `/api/v1/industry-workspaces/${encodeURIComponent(input.workspaceId)}/candidates/${encodeURIComponent(head.candidateId)}/source-confirmations`,
      { contentDigest: head.contentDigest, sourceRef: input.sourceRef, fragmentIndex: 0, reason: '人工读取并确认该候选对应的真实上传原文片段。' },
      await workspaceHead(input.call, input.workspaceId),
    )
    const replacements = confirmed['candidates']
    if (!Array.isArray(replacements) || replacements.length !== 1) throw new Error(`candidate ${head.candidateId} source confirmation did not return one replacement head`)
    const replacement = object(replacements[0], 'source-confirmed candidate')
    const candidateId = text(replacement['candidateId'], 'source-confirmed candidate ID')
    const replacementDigest = text(replacement['contentDigest'], 'source-confirmed content digest')
    const reviews = await input.call(`/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`)
    const reviewValues = reviews['reviews']
    if (!Array.isArray(reviewValues)) throw new Error(`review history was missing for current candidate ${candidateId}`)
    let latestRevision = '0'
    for (const value of reviewValues) {
      const review = object(value, 'candidate review')
      const revision = text(review['revision'], 'candidate review revision')
      if (BigInt(revision) > BigInt(latestRevision)) latestRevision = revision
    }
    const approval = await input.call(`/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`, {
      decision: 'approve',
      reason: '人工核对已读取的原文片段与当前候选内容。',
    }, latestRevision)
    if (approval['candidateId'] !== candidateId || approval['contentDigest'] !== replacementDigest || approval['decision'] !== 'approve') {
      throw new Error(`human approval did not pin the source-confirmed current candidate ${candidateId}`)
    }
    confirmedCandidateIds.push(candidateId)
  }
  return confirmedCandidateIds
}

/** Creates and approves an independent CQ bound to the actual preview definition/rule and original CSV bytes. */
export async function prepareOrCompetency(input: {
  readonly baseUrl: string
  readonly workspaceId: string
  readonly exampleSetId: string
  readonly scopeRef: ScopeRef
  readonly sourceRef: ResourceRef
  readonly policyText: string
  readonly call: GenericOrCall
}): Promise<PreparedOrCompetency> {
  const head = await workspaceHead(input.call, input.workspaceId)
  const preview = await input.call(`/api/v1/core/workspaces/${encodeURIComponent(input.workspaceId)}/execution-preview`, {
    exampleSetId: input.exampleSetId,
  }, head)
  const definitionRef = actualVersionRef(preview['definitionRef'], 'actual execution preview definition')
  const rawRules = preview['ruleRefs']
  if (!Array.isArray(rawRules) || rawRules.length !== 1) throw new Error('execution preview did not return the exact OR rule version')
  const ruleRef = actualVersionRef(rawRules[0], 'actual execution preview rule')

  const nativeCsv = 'asset_code,inspection_due\nasset-code-1,false\n'
  const sourceResponse = await fetch(`${input.baseUrl}/api/v1/competency-question-sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-source-media-type': 'text/csv' },
    body: nativeCsv,
    signal: AbortSignal.timeout(30_000),
  })
  const sourceBodyText = await sourceResponse.text()
  if (!sourceResponse.ok) throw new Error(`actual independent CSV upload failed: ${sourceResponse.status} ${sourceBodyText}`)
  const sourceEnvelope = object(JSON.parse(sourceBodyText) as unknown, 'competency source upload envelope')
  const sourceData = object(sourceEnvelope['data'], 'competency source upload data')
  const originalCsvRef = actualVersionRef(sourceData['sourceRef'], 'actual competency CSV reference')
  const csvLocation = {
    sourceRef: originalCsvRef,
    startOffset: 0,
    endOffset: Buffer.byteLength(nativeCsv, 'utf8'),
    quoteDigest: originalCsvRef.digest,
    offsetUnit: 'utf8_byte' as const,
  }
  const policyLocation = {
    sourceRef: actualVersionRef(input.sourceRef, 'policy source version ref'),
    startOffset: 0,
    endOffset: Buffer.byteLength(input.policyText, 'utf8'),
    quoteDigest: input.sourceRef.digest,
    offsetUnit: 'utf8_byte' as const,
  }
  const logicalProjectId = randomUUID()
  const caseId = randomUUID()
  const questionId = randomUUID()
  const body = {
    schemaVersion: 'competency-questions@1',
    classification: 'synthetic_demo_not_an_industry_standard',
    execution: 'not_run',
    industryId: text(object((await input.call(`/api/v1/industry-workspaces/${encodeURIComponent(input.workspaceId)}`))['workspace'], 'industry workspace')['namespace'], 'workspace namespace'),
    definitionRefs: [definitionRef],
    ruleRefs: [ruleRef],
    sourceRefs: uniqueRefs([
      { id: input.sourceRef.id, version: input.sourceRef.version, digest: input.sourceRef.digest },
      { id: originalCsvRef.id, version: originalCsvRef.version, digest: originalCsvRef.digest },
    ]),
    allowedCapabilities: ['semantic_read'],
    externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] },
    questions: [{
      questionId,
      question: '在 inspection_due=false 时，asset-code-1 是否仍符合已审核的 OR 规则条件？',
      taskKind: 'rule_judgement',
      definitionRef,
      ruleRefs: [ruleRef],
      input: {
        dataMode: 'synthetic',
        scopeRef: input.scopeRef,
        projectId: logicalProjectId,
        validAt: '2026-10-10T00:00:00Z',
        asOfRecordedSeq: '1',
        observations: [
          { factId: `${caseId}:asset-code`, entityId: 'asset-code-1', objectId: 'asset', attributeId: 'asset_code', value: 'asset-code-1', recordedSeq: '1', status: 'active', source: csvLocation },
          { factId: `${caseId}:inspection-due`, entityId: 'asset-code-1', objectId: 'asset', attributeId: 'inspection_due', value: false, recordedSeq: '1', status: 'active', source: csvLocation },
        ],
        relations: [],
        structuredSources: [{ sourceRef: originalCsvRef, objectId: 'asset', attributeIds: ['asset_code', 'inspection_due'] }],
      },
      intent: { kind: 'rule', projectId: logicalProjectId, objectId: 'asset', subjectEntityId: 'asset-code-1', ruleId: 'inspection_due_or_network' },
      requiredCapabilities: ['semantic_read'],
      requiredSources: [policyLocation, csvLocation],
      expected: { kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'unknown' },
      goldOrigin: 'authored_oracle',
      derivation: '人工独立核对：inspection_due=false 使第一个条件不成立，asset_code=asset-code-1 使另一个 OR 条件成立；不填写业务结论。',
      specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'],
    }],
  }
  const proposedRef = { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(body) }
  const saved = await input.call('/api/v1/competency-question-sets', { ref: proposedRef, body })
  if (saved['approvalRequired'] !== true || typeof saved['candidateId'] !== 'string') throw new Error('server did not store the independently authored competency question as a review candidate')
  const declaration = object(saved['declaration'], 'stored competency question declaration')
  const competencyQuestionRef = actualVersionRef(declaration['ref'], 'server-issued competency question reference')
  if (saved['candidateId'] !== competencyQuestionRef.id || competencyQuestionRef.digest !== proposedRef.digest) throw new Error('server-issued competency question reference did not pin the submitted body')
  const storedBody = object(declaration['body'], 'stored competency question body')
  if (contentDigestOf(storedBody) !== proposedRef.digest) throw new Error('server-stored competency body differs from the independent authoring request')
  const reviews = await input.call(`/api/v1/candidates/${encodeURIComponent(competencyQuestionRef.id)}/reviews`)
  const reviewValues = reviews['reviews']
  if (!Array.isArray(reviewValues)) throw new Error('competency question review history was missing')
  let latestRevision = '0'
  for (const value of reviewValues) {
    const review = object(value, 'competency review')
    const revision = text(review['revision'], 'competency review revision')
    if (BigInt(revision) > BigInt(latestRevision)) latestRevision = revision
  }
  const approval = await input.call(`/api/v1/candidates/${encodeURIComponent(competencyQuestionRef.id)}/reviews`, {
    decision: 'approve',
    reason: '人工独立核对 OR 的 false/true 输入、预期条件与原始 CSV 单元格。',
  }, latestRevision)
  if (approval['candidateId'] !== competencyQuestionRef.id || approval['contentDigest'] !== competencyQuestionRef.digest || approval['decision'] !== 'approve') {
    throw new Error('CQ human review did not approve the exact server-issued body')
  }
  const readback = await input.call('/api/v1/competency-question-sets/read', { ref: competencyQuestionRef })
  const readbackDeclaration = object(readback['declaration'], 'readback competency declaration')
  if (readback['approved'] !== true || contentDigestOf(object(readbackDeclaration['body'], 'readback competency body')) !== competencyQuestionRef.digest) {
    throw new Error('approved competency question failed exact service readback')
  }
  return { competencyQuestionRef, definitionRef }
}
