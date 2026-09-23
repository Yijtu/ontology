import { randomUUID } from 'node:crypto'
import type { AnswerDraft, DraftWriterPort, DraftClaim, DraftWriterRequest, DraftWriterResult, DocumentSpan, EvidenceStorePort, ImmutableArtifactWriter, ResourceKind, ResourceRef, ScopeRef, Sha256Digest, ToolContext, VerifiedAssertion } from '@ontology/contracts'
import { answerDraftContentHash } from '@ontology/application'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'

export interface TaskDraftEvidence {
  readonly evidence: EvidenceStorePort
  readonly artifacts: ImmutableArtifactWriter
  readonly blobStore: LocalImmutableBlobStore
}

interface EvidencePayload {
  readonly ref: NonNullable<import('@ontology/contracts').WorkflowInputEntry['ref']>
  readonly resultDigest: string
  readonly payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function evidencePayloads(request: DraftWriterRequest, deps: TaskDraftEvidence, ctx: ToolContext): Promise<readonly EvidencePayload[]> {
  const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const entries = request.inputManifest.entries.filter((entry) => entry.kind === 'evidence' && entry.ref !== undefined)
  const output: EvidencePayload[] = []
  for (const entry of entries) {
    const ref = entry.ref
    if (ref === undefined) continue
    const record = await deps.evidence.get(scope, ref.id, ctx)
    if (record?.envelope.payloadRef === undefined) throw new Error('task evidence payload is unavailable')
    const bytes = await deps.blobStore.readAuthorized({ scopeRef: scope, blobRef: record.envelope.payloadRef }, ctx)
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('task evidence payload is malformed')
    output.push({ ref, resultDigest: record.envelope.resultDigest, payload: payload as Record<string, unknown> })
  }
  return output
}

export function draftFromVerifiedAssertions(request: DraftWriterRequest, assertions: readonly VerifiedAssertion[], limitations: readonly string[], claims: readonly DraftClaim[] = []): AnswerDraft {
  const blocks = [
    ...claims.map((claim) => ({ kind: 'claim', claimId: claim.claimId })),
    ...assertions.map((assertion) => ({ kind: 'assertion', assertionId: assertion.assertionId })),
  ]
  const schemaVersion = 'answer-draft@2' as const
  const draft: AnswerDraft = {
    draftId: randomUUID(), runId: request.runId, schemaVersion, blocks, claims, assertions,
    evidenceManifestHash: request.inputManifest.digest,
    contentHash: answerDraftContentHash(request.runId, blocks, request.inputManifest.digest, claims, assertions, { schemaVersion, limitations }),
    limitations, producedInPhase: 'drafting', createdAt: new Date().toISOString(),
  }
  return draft
}

async function archiveDraft(draft: AnswerDraft, dependencies: TaskDraftEvidence, ctx: ToolContext): Promise<DraftWriterResult> {
  const scopeRef: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const content = new TextEncoder().encode(JSON.stringify(draft))
  const archived = await dependencies.artifacts.putBytes({
    scopeRef,
    content,
    mediaType: 'application/vnd.ontology.answer-draft+json',
  }, ctx)
  return { draft, evidenceRefs: [archived.blobRef] }
}

function resourceRefOf(value: unknown): ResourceRef | undefined {
  if (!isRecord(value)) return undefined
  const record = value
  if (typeof record['id'] !== 'string' || typeof record['version'] !== 'string' || typeof record['digest'] !== 'string') return undefined
  const kind = record['kind']
  if (!isResourceKind(kind) || !isSha256Digest(record['digest'])) return undefined
  return { id: record['id'], version: record['version'], digest: record['digest'], kind }
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === 'artifact' || value === 'dataset' || value === 'document' || value === 'evidence' || value === 'profile' || value === 'object' || value === 'plan' || value === 'job' || value === 'candidate'
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function documentLocatorOf(value: unknown): DocumentSpan['locator'] | undefined {
  if (!isRecord(value) || !('kind' in value)) return undefined
  const locator = value
  const kind = locator['kind']
  if (kind !== 'page' && kind !== 'offset' && kind !== 'approximate_locator') return undefined
  if (locator['page'] !== undefined && typeof locator['page'] !== 'number') return undefined
  if (locator['startOffset'] !== undefined && typeof locator['startOffset'] !== 'number') return undefined
  if (locator['endOffset'] !== undefined && typeof locator['endOffset'] !== 'number') return undefined
  if (locator['normalizationMapRef'] !== undefined && typeof locator['normalizationMapRef'] !== 'string') return undefined
  return {
    kind,
    ...(typeof locator['page'] === 'number' ? { page: locator['page'] } : {}),
    ...(typeof locator['startOffset'] === 'number' ? { startOffset: locator['startOffset'] } : {}),
    ...(typeof locator['endOffset'] === 'number' ? { endOffset: locator['endOffset'] } : {}),
    ...(typeof locator['normalizationMapRef'] === 'string' ? { normalizationMapRef: locator['normalizationMapRef'] } : {}),
  }
}

export function createTransportInspectionDraftWriter(dependencies: TaskDraftEvidence): DraftWriterPort {
  return {
    async writeDraft(request, ctx) {
      const evidence = await evidencePayloads(request, dependencies, ctx)
      const assertions: VerifiedAssertion[] = []
      for (const item of evidence) {
        const table = item.payload['table']
        if (typeof table !== 'object' || table === null || Array.isArray(table)) continue
        const columns = (table as Record<string, unknown>)['columns']
        const rows = (table as Record<string, unknown>)['rows']
        if (!Array.isArray(columns) || !Array.isArray(rows)) continue
        const fieldName = (column: unknown): string | undefined => {
          if (!isRecord(column)) return undefined
          return typeof column['semanticFieldRef'] === 'string' ? column['semanticFieldRef'] : typeof column['name'] === 'string' ? column['name'] : undefined
        }
        const facilityIndex = columns.findIndex((column) => fieldName(column) === 'facility_id')
        const districtIndex = columns.findIndex((column) => fieldName(column) === 'district')
        const stateIndex = columns.findIndex((column) => fieldName(column) === 'inspection_state')
        if (facilityIndex < 0 || districtIndex < 0 || stateIndex < 0) continue
        for (const [rowIndex, row] of rows.entries()) {
          if (!Array.isArray(row)) continue
          const facility = row[facilityIndex], district = row[districtIndex], state = row[stateIndex]
          if (typeof facility !== 'string' || typeof district !== 'string' || typeof state !== 'string') continue
          const facilityId = randomUUID()
          assertions.push(
            { assertionId: facilityId, kind: 'string', subject: facility, predicate: 'facility_id', value: facility, references: [{ evidenceRef: item.ref, resultDigest: item.resultDigest, valuePointer: `/table/rows/${String(rowIndex)}/${String(facilityIndex)}`, subjectPointer: `/table/rows/${String(rowIndex)}/${String(facilityIndex)}` }] },
            { assertionId: randomUUID(), kind: 'enum', subject: facility, predicate: 'inspection_state', value: state, references: [{ evidenceRef: item.ref, resultDigest: item.resultDigest, valuePointer: `/table/rows/${String(rowIndex)}/${String(stateIndex)}`, subjectPointer: `/table/rows/${String(rowIndex)}/${String(facilityIndex)}` }] },
            { assertionId: randomUUID(), kind: 'string', subject: facility, predicate: 'district', value: district, references: [{ evidenceRef: item.ref, resultDigest: item.resultDigest, valuePointer: `/table/rows/${String(rowIndex)}/${String(districtIndex)}`, subjectPointer: `/table/rows/${String(rowIndex)}/${String(facilityIndex)}` }] },
          )
        }
      }
      if (assertions.length === 0) throw new Error('the query evidence contains no typed inspection rows')
      return archiveDraft(draftFromVerifiedAssertions(request, assertions, ['设施清单来自该 profile 授权的只读 DuckDB 结构化来源；合成 fixture，不代表真实道路资产。']), dependencies, ctx)
    },
  }
}

export function createDocumentQuoteDraftWriter(dependencies: TaskDraftEvidence): DraftWriterPort {
  return {
    async writeDraft(request, ctx) {
      const evidence = await evidencePayloads(request, dependencies, ctx)
      for (const item of evidence) {
        const quotes = item.payload['quotes']
        if (!Array.isArray(quotes)) continue
        for (const [index, rawQuote] of quotes.entries()) {
          if (!isRecord(rawQuote)) continue
          const documentRef = resourceRefOf(rawQuote['documentRef'])
          const locator = documentLocatorOf(rawQuote['locator'])
          const text = rawQuote['text']
          const textDigest = rawQuote['textDigest']
          const quoteDigest = rawQuote['quoteDigest']
          const precision = rawQuote['precision']
          if (documentRef === undefined || locator === undefined || typeof text !== 'string' || !isSha256Digest(textDigest) || !isSha256Digest(quoteDigest) || (precision !== 'exact' && precision !== 'approximate')) continue
          const prefix = `/quotes/${String(index)}`
          const assertion: VerifiedAssertion = {
            assertionId: randomUUID(), kind: 'document_quote', subject: documentRef.id,
            predicate: 'source_quote', quote: text, documentRef, locator, quoteDigest, textDigest, precision,
            references: [{ evidenceRef: item.ref, resultDigest: item.resultDigest, valuePointer: `${prefix}/text`, subjectPointer: `${prefix}/documentRef/id`, documentPointer: `${prefix}/documentRef`, locatorPointer: `${prefix}/locator`, textDigestPointer: `${prefix}/textDigest`, quoteDigestPointer: `${prefix}/quoteDigest` }],
          }
        return archiveDraft(draftFromVerifiedAssertions(request, [assertion], ['答案正文为原文精确引文；BM25 关键词命中用于定位，不代表对整个文件内容作了语义穷尽判定。']), dependencies, ctx)
        }
      }
      throw new Error('document search returned no exact quote span')
    },
  }
}

function energyCostClaim(options: { readonly evidenceRef: ResourceRef; readonly resultDigest: string; readonly key: string; readonly value: number; readonly unit: string }): DraftClaim {
  return {
    claimId: randomUUID(), subject: 'home-energy.plan', predicate: options.key,
    value: { value: options.value, unit: options.unit }, time: {}, kind: 'computation',
    references: [{ evidenceRef: options.evidenceRef, resultDigest: options.resultDigest, valuePointer: `/computation/metrics/${options.key}`, unitPointer: `/computation/metrics/units/${options.key}`, subjectPointer: '/computation/operationRef/id' }],
  }
}

export function buildEnergyDraftWriter(dependencies: TaskDraftEvidence): DraftWriterPort {
  return {
    async writeDraft(request, ctx) {
      const evidence = await evidencePayloads(request, dependencies, ctx)
      const claims: DraftClaim[] = []
      for (const item of evidence) {
        const table = item.payload['table']
        if (isRecord(table) && Array.isArray(table['columns']) && Array.isArray(table['rows'])) {
          const columns = table['columns'].filter(isRecord)
          const rows = table['rows']
          const siteIndex = columns.findIndex((column) => column['semanticFieldRef'] === 'site_ref' || column['name'] === 'site_ref')
          const valueIndex = columns.findIndex((column) => column['semanticFieldRef'] === 'soc_percent' || column['name'] === 'soc_percent')
          const row = rows[0]
          if (Array.isArray(row) && siteIndex >= 0 && valueIndex >= 0 && typeof row[siteIndex] === 'string' && typeof row[valueIndex] === 'string' && typeof columns[valueIndex]?.['unit'] === 'string') {
            const numeric = Number(row[valueIndex])
            if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) {
              const unit = columns[valueIndex]?.['unit']
              if (typeof unit === 'string') claims.push({ claimId: randomUUID(), subject: row[siteIndex], predicate: 'soc_percent', value: { value: numeric, unit }, time: {}, kind: 'observation', references: [{ evidenceRef: item.ref, resultDigest: item.resultDigest, valuePointer: `/table/rows/0/${String(valueIndex)}`, unitPointer: `/table/columns/${String(valueIndex)}/unit`, subjectPointer: `/table/rows/0/${String(siteIndex)}` }] })
            }
          }
        }
        const computation = item.payload['computation']
        if (!isRecord(computation) || !isRecord(computation['metrics'])) continue
        const metrics = computation['metrics']
        const candidate = metrics['candidate_total_cost'], baseline = metrics['baseline_total_cost'], terminal = metrics['terminal_energy_kwh'], reserve = metrics['reserve_satisfied']
        if (typeof candidate !== 'number' || typeof baseline !== 'number' || typeof terminal !== 'number' || typeof reserve !== 'number') throw new Error('the registered energy operation did not return its bounded summary metrics')
        claims.push(
          energyCostClaim({ evidenceRef: item.ref, resultDigest: item.resultDigest, key: 'candidate_total_cost', value: candidate, unit: 'CNY' }),
          energyCostClaim({ evidenceRef: item.ref, resultDigest: item.resultDigest, key: 'baseline_total_cost', value: baseline, unit: 'CNY' }),
          energyCostClaim({ evidenceRef: item.ref, resultDigest: item.resultDigest, key: 'terminal_energy_kwh', value: terminal, unit: 'kWh' }),
          energyCostClaim({ evidenceRef: item.ref, resultDigest: item.resultDigest, key: 'reserve_satisfied', value: reserve, unit: 'boolean' }),
        )
      }
      if (!claims.some((claim) => claim.predicate === 'soc_percent')) throw new Error('energy task cannot publish without source-bound SOC')
      const limitations = [
        '本地受控演示使用合成数据；SOC 来自 profile 映射的合成 DuckDB 来源。',
        ...(claims.some((claim) => claim.predicate === 'candidate_total_cost') ? ['费用是已测试策略候选的确定性模拟值，不是全局最优；不会连接或控制真实设备。逐时段计划可从已发布答案的计划详情端点读取。'] : []),
      ]
      return archiveDraft(draftFromVerifiedAssertions(request, [], limitations, claims), dependencies, ctx)
    },
  }
}
