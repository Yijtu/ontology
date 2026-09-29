import { createHash } from 'node:crypto'
import { answerDraftContentHash } from '@ontology/application'
import type { DraftWriterPort } from '@ontology/contracts'
import type {
  AnswerDraft,
  DraftWriterRequest,
  DraftWriterResult,
  EvidenceStorePort,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

export interface PublishedFactsDraftWriterOptions {
  readonly evidence: EvidenceStorePort
  readonly artifacts: {
    getAuthorized(request: { readonly scopeRef: ScopeRef; readonly blobRef: ResourceRef }, ctx: ToolContext): Promise<{ readonly integrityVerified: boolean }>
    readAuthorized(request: { readonly scopeRef: ScopeRef; readonly blobRef: ResourceRef }, ctx: ToolContext): Promise<Uint8Array>
  }
  readonly now?: () => string
}

interface PublishedFactPayload {
  readonly subjectEntityId: string
  readonly objectId: string
  readonly attributeId: string
  readonly value: unknown
  readonly unitCode?: string
  readonly schemaRef: VersionRef
  readonly sourceStatementId: string
  readonly sourceRefs: readonly ResourceRef[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameRef(value: unknown, expected: ResourceRef): boolean {
  if (!isRecord(value)) return false
  return value['id'] === expected.id && value['version'] === expected.version &&
    value['digest'] === expected.digest && value['kind'] === expected.kind
}

function versionRef(value: unknown): value is VersionRef {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string' && typeof value['version'] === 'string' &&
    typeof value['digest'] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value['digest'])
}

function factOf(item: unknown): PublishedFactPayload | undefined {
  if (!isRecord(item) || item['kind'] !== 'fact' || !versionRef(item['ref']) || !isRecord(item['payload'])) return undefined
  const payload = item['payload']
  if (
    typeof payload['subjectEntityId'] !== 'string' || payload['subjectEntityId'].length === 0 ||
    typeof payload['objectId'] !== 'string' || payload['objectId'].length === 0 ||
    typeof payload['attributeId'] !== 'string' || payload['attributeId'].length === 0 ||
    typeof payload['sourceStatementId'] !== 'string' || payload['sourceStatementId'].length === 0 ||
    !versionRef(payload['schemaRef']) || !Array.isArray(payload['sourceRefs']) ||
    !payload['sourceRefs'].every((ref) => isRecord(ref) && typeof ref['id'] === 'string') ||
    !Object.hasOwn(payload, 'value')
  ) return undefined
  return {
    subjectEntityId: payload['subjectEntityId'],
    objectId: payload['objectId'],
    attributeId: payload['attributeId'],
    value: payload['value'],
    ...(typeof payload['unitCode'] === 'string' ? { unitCode: payload['unitCode'] } : {}),
    schemaRef: payload['schemaRef'],
    sourceStatementId: payload['sourceStatementId'],
    sourceRefs: payload['sourceRefs'] as ResourceRef[],
  }
}

function resourceKindOf(value: unknown): 'boolean' | 'string' | 'quantity' | undefined {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number' && Number.isFinite(value)) return 'quantity'
  if (isRecord(value) && typeof value['amount'] === 'string' && typeof value['unit'] === 'string') return 'quantity'
  return undefined
}

export class PublishedFactsDraftWriterError extends Error {
  readonly code = 'INSUFFICIENT_DATA'
  readonly httpStatus = 422

  constructor(message: string) {
    super(message)
    this.name = 'PublishedFactsDraftWriterError'
  }
}

function stableUuid(value: string): Uuid {
  const chars = [...createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Deterministically render only source-backed published attribute values from the real
 * ontology_lookup result artifact. No free prose is accepted, and every block references a
 * typed claim/assertion whose field pointer the hard verifier rechecks against the archive.
 */
export class PublishedFactsDraftWriter implements DraftWriterPort {
  readonly recoverySafety = 'idempotent' as const
  readonly #options: PublishedFactsDraftWriterOptions
  readonly #now: () => string

  constructor(options: PublishedFactsDraftWriterOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    const scopeRef: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const claims: NonNullable<AnswerDraft['claims']>[number][] = []
    const assertions: NonNullable<AnswerDraft['assertions']>[number][] = []
    const usedEvidenceRefs: ResourceRef[] = []
    const seenEvidenceIds = new Set<string>()
    const evidenceEntries = request.inputManifest.entries.filter(
      (entry) => entry.kind === 'evidence' && entry.ref !== undefined,
    )
    let factCount = 0

    for (const entry of evidenceEntries) {
      const evidenceRef = entry.ref
      if (evidenceRef === undefined || evidenceRef.kind !== 'evidence') continue
      const record = await this.#options.evidence.get(scopeRef, evidenceRef.id, ctx)
      if (record === undefined || !sameRef(record.evidenceRef, evidenceRef)) continue
      const payloadRef = record.envelope.payloadRef
      if (payloadRef === undefined) continue
      const requestRef = { scopeRef, blobRef: payloadRef }
      const authorized = await this.#options.artifacts.getAuthorized(requestRef, ctx)
      if (!authorized.integrityVerified) continue
      const bytes = await this.#options.artifacts.readAuthorized(requestRef, ctx)
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      if (!isRecord(payload) || !Array.isArray(payload['items'])) continue
      if (Array.isArray(payload['gaps']) && payload['gaps'].length > 0) {
        throw new PublishedFactsDraftWriterError('published fact coverage is incomplete; no answer body was drafted')
      }
      if (payload['items'].some((item) => !isRecord(item) || item['kind'] !== 'fact')) {
        throw new PublishedFactsDraftWriterError('ontology_lookup returned a non-fact or mixed fact page')
      }
      if (!seenEvidenceIds.has(evidenceRef.id)) {
        usedEvidenceRefs.push(evidenceRef)
        seenEvidenceIds.add(evidenceRef.id)
      }

      for (const [index, item] of payload['items'].entries()) {
        const fact = factOf(item)
        if (fact === undefined) {
          throw new PublishedFactsDraftWriterError('a published fact lacks a complete schema/entity/source binding')
        }
        const valueKind = resourceKindOf(fact.value)
        if (valueKind === undefined) {
          throw new PublishedFactsDraftWriterError('a published fact value type is not supported by the typed answer renderer')
        }
        factCount += 1
        const claimKey = `${request.runId}:${evidenceRef.id}:${fact.sourceStatementId}:${fact.attributeId}:${String(index)}`
        const assertionId = stableUuid(`assertion:${claimKey}`)
        const valuePointer = valueKind === 'quantity' && isRecord(fact.value)
          ? `/items/${String(index)}/payload/value/amount`
          : `/items/${String(index)}/payload/value`
        const unitPointer = `/items/${String(index)}/payload/unitCode`
        const subjectPointer = `/items/${String(index)}/payload/subjectEntityId`
        const fieldRefPointer = `/items/${String(index)}/payload/attributeId`

        if (valueKind === 'quantity') {
          if (fact.unitCode === undefined) {
            throw new PublishedFactsDraftWriterError('a numeric published fact has no unit')
          }
          const amount = isRecord(fact.value) ? fact.value['amount'] : fact.value
          if (typeof amount !== 'string' && typeof amount !== 'number') {
            throw new PublishedFactsDraftWriterError('a numeric published fact has no exact amount')
          }
          const claimId = stableUuid(`claim:${claimKey}`)
          claims.push({
            claimId,
            subject: fact.subjectEntityId,
            predicate: fact.attributeId,
            value: { value: amount, unit: fact.unitCode },
            time: {},
            kind: 'observation',
            references: [{
              evidenceRef,
              resultDigest: record.envelope.resultDigest,
              valuePointer,
              unitPointer,
              subjectPointer,
              fieldRefPointer,
            }],
          })
          continue
        }

        const assertionValue = fact.value
        if (typeof assertionValue !== 'string' && typeof assertionValue !== 'boolean') {
          throw new PublishedFactsDraftWriterError('a published fact cannot be rendered as a typed assertion')
        }
        const baseAssertion = {
          assertionId,
          subject: fact.subjectEntityId,
          predicate: fact.attributeId,
          references: [{
            evidenceRef,
            resultDigest: record.envelope.resultDigest,
            valuePointer,
            subjectPointer,
            fieldRefPointer,
          }],
        }
        assertions.push(typeof assertionValue === 'boolean'
          ? { ...baseAssertion, kind: 'boolean', value: assertionValue }
          : { ...baseAssertion, kind: 'string', value: assertionValue })
      }
    }

    if (factCount === 0) {
      throw new PublishedFactsDraftWriterError('no complete published attribute facts were available for the answer')
    }

    const blocks: readonly unknown[] = [
      ...claims.map((claim) => ({ kind: 'claim', claimId: claim.claimId })),
      ...assertions.map((assertion) => ({ kind: 'assertion', assertionId: assertion.assertionId })),
    ]
    const limitations: string[] = []
    const draftId = stableUuid(`draft:${request.runId}:${request.inputManifest.digest}`)
    const createdAt = this.#now()
    const schemaVersion = 'answer-draft@2' as const
    const evidenceManifestHash = request.inputManifest.digest
    const draft: AnswerDraft = {
      draftId,
      runId: request.runId,
      schemaVersion,
      blocks,
      claims,
      assertions,
      evidenceManifestHash,
      contentHash: answerDraftContentHash(request.runId, blocks, evidenceManifestHash, claims, assertions, { schemaVersion, limitations }),
      limitations,
      producedInPhase: 'drafting',
      createdAt,
    }
    return { draft, usage: { durationMs: 0, calls: 0, modelTokens: 0 }, evidenceRefs: usedEvidenceRefs }
  }
}
