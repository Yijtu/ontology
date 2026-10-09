import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalDecimal } from '@ontology/application'
import { actualArray, actualObject, actualResource, actualText, confirmFirstActiveCandidate, createFirstActiveProject, firstActiveEntries, firstActiveQuery, publishFirstActiveFacts, startFirstActiveFixture, waitFirstActiveEvolution } from './core-first-active-fixture'
import type { FirstActiveFixture, FirstActivePack, FirstActiveProject } from './core-first-active-fixture'

let f: FirstActiveFixture, p1: FirstActivePack, p2: FirstActivePack
beforeAll(async () => {
  f = await startFirstActiveFixture()
  p1 = await f.publishPack('h', false)
  p2 = await f.publishPack('min', true)
  expect(p1.definitionRef.id).not.toBe(p2.definitionRef.id)
  expect(p1.packRef).not.toEqual(p2.packRef)
  expect(f.modelCalls).toEqual(Array.from({ length: 4 }, () => 'controlled-source-proposal'))
})
afterAll(async () => { await f?.close() })

async function startUpgrade(project: FirstActiveProject) {
  const prior = actualObject(project.revision['ref']), before = await f.harness.adminClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding#>>'{request,projectRevisionRef,projectId}'=$3`, [f.scope.tenantId, f.scope.spaceId, project.projectId])
  expect(before.rows[0]?.count).toBe('0')
  const response = await f.call(`/api/v1/projects/${project.projectId}/evolutions`, { industryPackRef: p2.packRef, profileRef: p2.profileRef, strategy: { kind: 'keep_independent', reason: '人工明确选择独立命名空间的新工时定义' }, remappings: [{ mappingRef: project.mapping['ref'], documentId: project.documentId, objectId: 'machine', entries: firstActiveEntries(project.sourceColumns, true) }], maxRecords: 2, maxAttempts: 1 }, actualText(prior['revision']))
  const evolution = actualObject(response['evolution']), plan = actualObject(evolution['plan']), previousInputRef = actualResource(plan['previousInputRef']), target = actualObject(plan['targetRevisionRef'])
  expect(plan['previousRevisionRef']).toEqual(prior)
  const seal = await f.readArtifact(previousInputRef, p1.profileRef)
  expect(seal).toMatchObject({ schemaVersion: 'project-input-snapshot@1', projectId: project.projectId, inputRevision: prior['revision'], definitionRef: p1.definitionRef, counts: { total: 2, approved: 2, confirmed: 2, excluded: 0 } })
  const minted = await f.harness.adminClient.query<{ before_staging: boolean }>(`SELECT a.created_at <= r.recorded_at AS before_staging FROM agent_platform.artifact_references a JOIN agent_platform.project_revisions r ON r.tenant_id=a.tenant_id AND r.space_id=a.space_id WHERE a.tenant_id=$1 AND a.space_id=$2 AND a.blob_ref_id=$3 AND r.project_id=$4 AND r.revision=$5::bigint`, [f.scope.tenantId, f.scope.spaceId, previousInputRef.id, project.projectId, actualText(target['revision'])])
  expect(minted.rows).toEqual([{ before_staging: true }])
  return { evolutionId: actualText(plan['evolutionId']), plan, previousInputRef, seal }
}

async function tableRows(answer: Record<string, unknown>) {
  const result = await f.call(`/api/v1/answers/${actualText(answer['answerId'])}/result`), table = actualObject(actualArray(result['tables'])[0])
  expect(result['tables']).toHaveLength(1)
  const page = await f.call(`/api/v1/answers/${actualText(answer['answerId'])}/tables/${actualText(table['tableId'])}`), columns = actualArray(page['columns']).map(actualObject)
  const idColumn = columns.find((column) => column['semanticPredicate'] === 'machine_id'), quantityColumn = columns.find((column) => column['semanticPredicate'] === 'hours'), noteColumn = columns.find((column) => column['semanticPredicate'] === 'phase_note')
  if (idColumn === undefined || quantityColumn === undefined) throw new Error('actual formal table fields missing')
  const rows = actualArray(page['rows']).map((value) => {
    const cells = actualObject(actualObject(value)['cells']), quantity = actualObject(cells[actualText(quantityColumn['columnRef'])]), decimal = canonicalDecimal(actualText(quantity['value']))
    if (decimal === undefined) throw new Error('actual query lost exact numeric representation')
    return { id: actualText(cells[actualText(idColumn['columnRef'])]), hours: decimal, unit: actualText(quantity['unit']), ...(noteColumn === undefined ? {} : { note: cells[actualText(noteColumn['columnRef'])] }) }
  }).sort((left, right) => left.id.localeCompare(right.id))
  return { rows, columns }
}

describe('normal first query during a genuine staged ontology upgrade (real PG/HTTP/worker)', () => {
  it('seals P1 before staging without any prior query, keeps first old-active formal output and later activates independently reviewed P2', async () => {
    const project = await createFirstActiveProject(f, p1, '首次旧生效查询的合成证明'), upgrade = await startUpgrade(project)
    const staged = await waitFirstActiveEvolution(f, project.projectId, upgrade.evolutionId)
    expect(staged['state']).toBe('awaiting_review')
    const newIds = actualArray(staged['candidateIds']).map(actualText)
    expect(newIds).toHaveLength(2)
    for (const id of newIds) {
      expect(project.candidateIds).not.toContain(id)
      expect((await f.call(`/api/v1/candidates/${id}/reviews`))['reviews']).toEqual([])
      const record = actualObject((await f.call(`/api/v1/projects/${project.projectId}/instance-records/${id}`))['record'])
      expect(actualObject(record['identity'])['state']).toBe('unresolved')
      expect(actualArray(record['fields']).every((field) => actualObject(field)['status'] !== 'confirmed')).toBe(true)
    }
    // This is the first ordinary query, after the real worker has changed target physical
    // record heads. It cannot accidentally pass while the staging rebind is still queued.
    const old = await firstActiveQuery(f, project.projectId, p1.profileRef, ['machine_id', 'hours'])
    expect(actualObject(old.catalogue['revision'])['definitionRef']).toEqual(p1.definitionRef)
    expect(actualObject(old.catalogue['revision'])['profileRef']).toEqual(p1.profileRef)
    const oldTable = await tableRows(old.answer)
    expect(oldTable.rows).toEqual([{ id: 'OLD-A', hours: '9125e-3', unit: 'h' }, { id: 'OLD-B', hours: '1025e-2', unit: 'h' }])
    expect(oldTable.columns.map((column) => column['semanticPredicate'])).not.toContain('phase_note')
    const binding = await f.harness.adminClient.query<{ binding: unknown }>(`SELECT binding FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`, [f.scope.tenantId, f.scope.spaceId, old.runId])
    const savedBinding = actualObject(binding.rows[0]?.binding)
    expect(actualObject(savedBinding['request'])['inputSnapshotRef']).toEqual(upgrade.previousInputRef)
    expect(actualObject(savedBinding['request'])['projectRevisionRef']).toEqual(upgrade.plan['previousRevisionRef'])
    expect(savedBinding['projectDatasetSnapshotRef']).toEqual(project.snapshotRef)
    for (const id of newIds) await confirmFirstActiveCandidate(f, project.projectId, id)
    await publishFirstActiveFacts(f, newIds, p2.definitionRef)
    // Publishing the target advances the official recorded point, but P1 remains
    // active until activation. This later query must reuse the original seal.
    const transition = await firstActiveQuery(f, project.projectId, p1.profileRef, ['machine_id', 'hours'])
    expect(actualObject(transition.catalogue['revision'])['definitionRef']).toEqual(p1.definitionRef)
    expect(actualObject(transition.catalogue['revision'])['profileRef']).toEqual(p1.profileRef)
    const transitionTable = await tableRows(transition.answer)
    expect(transitionTable.rows).toEqual([{ id: 'OLD-A', hours: '9125e-3', unit: 'h' }, { id: 'OLD-B', hours: '1025e-2', unit: 'h' }])
    expect(transitionTable.columns.map((column) => column['semanticPredicate'])).not.toContain('phase_note')
    const transitionBinding = await f.harness.adminClient.query<{ binding: unknown }>(`SELECT binding FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`, [f.scope.tenantId, f.scope.spaceId, transition.runId])
    const savedTransitionBinding = actualObject(transitionBinding.rows[0]?.binding)
    expect(actualObject(savedTransitionBinding['request'])['inputSnapshotRef']).toEqual(upgrade.previousInputRef)
    expect(actualObject(savedTransitionBinding['request'])['projectRevisionRef']).toEqual(upgrade.plan['previousRevisionRef'])
    expect(savedTransitionBinding['projectDatasetSnapshotRef']).toEqual(project.snapshotRef)
    const activated = actualObject((await f.call(`/api/v1/projects/${project.projectId}/evolutions/${upgrade.evolutionId}/activate`, { relationCandidateIds: [] }))['evolution'])
    expect(activated['state']).toBe('ready')
    const next = await firstActiveQuery(f, project.projectId, p2.profileRef, ['machine_id', 'hours', 'phase_note'])
    expect(actualObject(next.catalogue['revision'])['definitionRef']).toEqual(p2.definitionRef); expect(actualObject(next.catalogue['revision'])['profileRef']).toEqual(p2.profileRef)
    expect((await tableRows(next.answer)).rows).toEqual([{ id: 'OLD-A', hours: '5475e-1', unit: 'min', note: 'staged-only-A' }, { id: 'OLD-B', hours: '615e0', unit: 'min', note: 'staged-only-B' }])
    const oldReadback = await f.call(`/api/v1/runs/${old.runId}/answer`)
    expect(oldReadback['contentHash']).toBe(old.answer['contentHash']); expect(oldReadback['v3Body']).toEqual(old.answer['v3Body'])
    const history = await f.call(`/api/v1/runs/${old.runId}/answer/history`)
    expect(actualArray(history['entries'])).toContainEqual(expect.objectContaining({ answerId: old.answer['answerId'], contentHash: old.answer['contentHash'] }))
    expect(f.workerErrors.map((error) => error instanceof Error ? error.message : error)).toEqual([])
  })

  it('refuses the real old seal after current human approval withdrawal and separately after actual source retraction, without a pre-staging query', async () => {
    const project = await createFirstActiveProject(f, p1, '旧封存输入当前人工裁决拒绝证明'), upgrade = await startUpgrade(project)
    expect((await waitFirstActiveEvolution(f, project.projectId, upgrade.evolutionId))['state']).toBe('awaiting_review')
    const catalogue = await f.call(`/api/v1/core/projects/${project.projectId}/task-catalogue`), binding = actualArray(catalogue['tasks']).map(actualObject).find((row) => row['taskKind'] === 'structured_query')
    if (binding === undefined) throw new Error('actual old-active query binding missing')
    const candidateId = project.candidateIds[0]; if (candidateId === undefined) throw new Error('original actual candidate missing')
    const reviews = actualArray((await f.call(`/api/v1/candidates/${candidateId}/reviews`))['reviews']).map(actualObject)
    const current = reviews.reduce<Record<string, unknown> | undefined>((latest, review) => latest === undefined || BigInt(actualText(review['revision'])) > BigInt(actualText(latest['revision'])) ? review : latest, undefined)
    if (current === undefined) throw new Error('actual old candidate review missing')
    expect(current['decision']).toBe('approve')
    const rejected = await f.call(`/api/v1/candidates/${candidateId}/reviews`, { decision: 'reject', reason: '人工撤回旧工时候选的当前内容批准' }, actualText(current['revision']))
    expect(rejected).toMatchObject({ candidateId, decision: 'reject', contentDigest: current['contentDigest'], revision: (BigInt(actualText(current['revision'])) + 1n).toString() })
    expect(actualArray((await f.call(`/api/v1/candidates/${candidateId}/reviews`))['reviews'])).toContainEqual(rejected)
    expect(await f.readArtifact(upgrade.previousInputRef, p1.profileRef)).toEqual(upgrade.seal)
    const query = { profileRef: { id: p1.profileRef.id, version: p1.profileRef.version }, projectId: project.projectId, question: '当前人工批准或原始来源撤回后，旧封存不能新发布答案', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { bindingRef: binding['bindingRef'], arguments: { objectId: 'machine', fields: ['machine_id', 'hours'], limit: 2 } } }
    const response = await f.rawCall('/api/v1/runs', query)
    const body = actualObject(await response.json() as unknown)
    expect(response.status).toBe(400)
    expect(actualObject(body['error'])['code']).toBe('INVALID_ARGUMENT')
    expect(actualText(actualObject(body['error'])['message'])).toMatch(/human.*(?:field|authority)|field.*identity/iu)
    const count = await f.harness.adminClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding#>>'{request,projectRevisionRef,projectId}'=$3`, [f.scope.tenantId, f.scope.spaceId, project.projectId])
    expect(count.rows[0]?.count).toBe('0')
    // Restore human approval through a new actual ledger act before withdrawing the
    // original. A human-review failure cannot stand in for the source negative.
    const restored = await f.call(`/api/v1/candidates/${candidateId}/reviews`, { decision: 'approve', reason: '人工重新核对同一候选内容，单独验证下一步原始资料撤回' }, actualText(rejected['revision']))
    expect(restored).toMatchObject({ candidateId, decision: 'approve', contentDigest: current['contentDigest'], revision: (BigInt(actualText(rejected['revision'])) + 1n).toString() })
    const priorStatus = actualObject((await f.call(`/api/v1/projects/${project.projectId}/document-index`))['status'])
    const withdrawn = actualObject((await f.call(`/api/v1/projects/${project.projectId}/document-memberships/${project.documentId}/revisions`, { op: 'retract', reason: '人工独立撤回旧封存所引用的实际原始CSV' }))['status'])
    expect(withdrawn['projectId']).toBe(project.projectId)
    expect(BigInt(actualText(withdrawn['visibilityEpoch']))).toBeGreaterThan(BigInt(actualText(priorStatus['visibilityEpoch'])))
    const membership = await f.harness.adminClient.query<{ state: string; document_ref: unknown }>(`SELECT state,document_ref FROM agent_platform.project_document_memberships WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND document_id=$4 ORDER BY membership_revision DESC LIMIT 1`, [f.scope.tenantId, f.scope.spaceId, project.projectId, project.documentId])
    expect(membership.rows).toEqual([{ state: 'retracted', document_ref: project.originalRef }])
    expect(await f.readArtifact(upgrade.previousInputRef, p1.profileRef)).toEqual(upgrade.seal)
    const sourceResponse = await f.rawCall('/api/v1/runs', query)
    const sourceBody = actualObject(await sourceResponse.json() as unknown)
    expect(sourceResponse.status, JSON.stringify(sourceBody)).toBe(422)
    expect(actualObject(sourceBody['error'])['code']).toBe('SOURCE_UNREADABLE')
    expect(actualText(actualObject(sourceBody['error'])['message'])).toMatch(/source|membership|visibility|corpus|document/iu)
    const finalCount = await f.harness.adminClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding#>>'{request,projectRevisionRef,projectId}'=$3`, [f.scope.tenantId, f.scope.spaceId, project.projectId])
    expect(finalCount.rows[0]?.count).toBe('0')
  })
})
