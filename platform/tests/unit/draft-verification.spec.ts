import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DraftVerificationService } from '@ontology/application'
import type {
  DecisionPort,
  EvidenceStorePort,
  ModelRef,
  ResourceRef,
  ToolContext,
  VerifiedAssertion,
  VerificationPolicy,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type { DraftVerificationDependencies, VerificationArtifactStore } from '@ontology/application'
import {
  BLOB_ID,
  ChattySemanticDecision,
  EVIDENCE_ID,
  FallbackDecision,
  FixedSemanticDecision,
  InMemoryVerificationArtifacts,
  InMemoryVerificationEvidence,
  NOW,
  RESULT_PAYLOAD,
  RUN_ID,
  buildClaim,
  buildDraft,
  buildEvidence,
  buildInputManifest,
  modelRef,
  ownerContext,
  verificationPolicy,
} from './verification-fixtures'
import {
  budgetHarness as jevBudgetHarness,
  makeAdapter,
  PLATFORM_MODEL_ID,
  remainingOf as jevRemainingOf,
  reservationsOf as jevReservationsOf,
  startJevServer,
} from './model-jev-fixtures'
import type { JevServer } from './model-jev-fixtures'
import { JevAdapterError, JevStateResolutionError, jevActualStateDigest } from '@ontology/adapter-model-jev'
import type { JevActualState } from '@ontology/adapter-model-jev'
import { createToolContext } from '@ontology/contracts'

type DecisionStateRefProvider = NonNullable<DraftVerificationDependencies['decisionStateRefProvider']>
const jevServers: JevServer[] = []

afterEach(async () => {
  while (jevServers.length > 0) await jevServers.pop()?.close()
})

interface HarnessOptions {
  readonly decision?: DecisionPort
  readonly modelRef?: ModelRef
  readonly policy?: VerificationPolicy
  readonly evidence?: EvidenceStorePort
  readonly artifacts?: VerificationArtifactStore
  readonly decisionStateRefProvider?: DecisionStateRefProvider | null
}

function buildService(options: HarnessOptions = {}) {
  const evidence = options.evidence ?? new InMemoryVerificationEvidence()
  const artifacts = options.artifacts ?? new InMemoryVerificationArtifacts()
  const archivedStates: unknown[] = []
  const decisionStateRefProvider = options.decisionStateRefProvider === null
    ? undefined
    : options.decisionStateRefProvider ?? {
        archive: async (input: { readonly runId: string; readonly resolvedProfileHash: string; readonly state: unknown }) => {
          archivedStates.push(input.state)
          return {
            id: randomUUID(),
            version: '1.0.0',
            digest: sha256DigestOf(JSON.stringify(input.state) ?? ''),
            kind: 'artifact' as const,
          }
        },
      }
  const service = new DraftVerificationService({
    evidence,
    artifacts,
    policy: options.policy ?? verificationPolicy(),
    modelRef: options.modelRef ?? modelRef(),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
    ...(decisionStateRefProvider === undefined ? {} : { decisionStateRefProvider }),
    now: () => NOW,
  })
  return { service, evidence, artifacts, archivedStates }
}

function verifyDraft(
  service: DraftVerificationService,
  request: Parameters<DraftVerificationService['verify']>[0],
  ctx: ToolContext,
): ReturnType<DraftVerificationService['verify']> {
  return service.verify({
    ...request,
    question: request.question ?? 'Does this evidence support the typed claim under review?',
  }, ctx)
}

function isJevState(value: unknown): value is JevActualState {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJevState)
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJevState)
}

function stateDraftHash(state: JevActualState): string {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new Error('semantic state fixture is not an object')
  }
  const value = Reflect.get(state, 'draftHash')
  if (typeof value !== 'string') throw new Error('semantic state fixture has no draft hash')
  return value
}

/** Register one archived result payload plus its evidence envelope. */
async function registerResult(input: {
  readonly evidence: InMemoryVerificationEvidence
  readonly artifacts: InMemoryVerificationArtifacts
  readonly payload?: unknown
  readonly validTo?: string
  readonly validFrom?: string
}) {
  const payloadRef = input.artifacts.put(BLOB_ID, input.payload ?? RESULT_PAYLOAD)
  const envelope = buildEvidence({
    payloadRef,
    resultDigest: payloadRef.digest,
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
  })
  const record = await input.evidence.record(
    { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    envelope,
  )
  return { record, ref: record.evidenceRef, resultDigest: payloadRef.digest }
}

describe('structured claim binding (D7.4, US-021)', () => {
  it('binds number, unit, subject and time to the cited result and passes', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const decision = new FixedSemanticDecision('supported')
    const { service } = buildService({ evidence, artifacts, decision })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('pass')
    expect(result.failedChecks).toEqual([])
    expect(result.supportedClaimIds).toEqual([claim.claimId])
    expect(result.findings).toEqual([])
    expect(result.draftHash).toBe(draft.contentHash)
    expect(result.evidenceManifestHash).toBe(manifest.digest)
    expect(result.policyVersion).toBe(verificationPolicy().policyVersion)
    expect(decision.calls).toHaveLength(1)
  })

  const injections = [
    { name: 'number', override: { value: 99 }, code: 'number_mismatch', field: 'value', pointer: '/value' },
    { name: 'unit', override: { unit: 'MWh' }, code: 'unit_mismatch', field: 'unit', pointer: '/unit' },
    {
      name: 'subject',
      override: { subject: 'site-other' },
      code: 'subject_mismatch',
      field: 'subject',
      pointer: '/subject',
    },
    {
      name: 'time',
      override: { asOf: '2020-01-01T00:00:00Z' },
      code: 'time_mismatch',
      field: 'time',
      pointer: '/time',
    },
  ] as const

  for (const injection of injections) {
    it(`locates an injected wrong ${injection.name} to the claim, field and evidence`, async () => {
      const ctx = ownerContext()
      const evidence = new InMemoryVerificationEvidence()
      const artifacts = new InMemoryVerificationArtifacts()
      const { ref, resultDigest } = await registerResult({ evidence, artifacts })
      const claim = buildClaim({ evidenceRef: ref, resultDigest, ...injection.override })
      const manifest = buildInputManifest([ref])
      const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
      const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

      const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

      expect(result.verdict).toBe('fail')
      expect(result.failedChecks).toContain(injection.code)
      const finding = result.findings?.find((entry) => entry.code === injection.code)
      expect(finding).toBeDefined()
      expect(finding?.axis).toBe('hard')
      expect(finding?.claimId).toBe(claim.claimId)
      expect(finding?.field).toBe(injection.field)
      expect(finding?.pointer).toBe(injection.pointer)
      expect(finding?.evidenceRef?.id).toBe(EVIDENCE_ID)
      const explanation = result.explanations?.find((entry) => entry.code === injection.code)
      expect(explanation?.message).toContain(claim.claimId)
      expect(explanation?.templateId).toContain(injection.code)
    })
  }
})

describe('V2 verified answer body and exact field binding', () => {
  const queryPayload = {
    resultKind: 'table',
    table: {
      columns: [
        { name: 'operating_hours', type: 'decimal', unit: 'h', semanticFieldRef: 'operating_hours' },
        { name: 'asset_id', type: 'string', semanticFieldRef: 'asset_id' },
        { name: 'observed_at', type: 'timestamp', semanticFieldRef: 'observed_at' },
      ],
      rows: [['100.000000000000000001', 'I-04', RESULT_PAYLOAD.time]],
    },
  }

  it('verifies a high precision decimal string and rejects unsupported visible prose even with a fresh hash', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: queryPayload })
    const claim = buildClaim({
      evidenceRef: ref,
      resultDigest,
      predicate: 'operating_hours',
      subject: 'I-04',
      value: '100.000000000000000001',
      unit: 'h',
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
      fieldRefPointer: '/table/columns/0',
      timePointer: '/table/rows/0/2',
    })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claim],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'claim', claimId: claim.claimId, text: 'I-04 has 1000 h.' }],
    })
    const { service } = buildService({
      evidence,
      artifacts,
      policy: verificationPolicy({ semanticReview: 'disabled' }),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toEqual(['visible_statement_unbound'])
    expect(result.supportedClaimIds).toEqual([claim.claimId])
  })

  it('treats evidence validFrom as a half-open boundary for query-time claims', async () => {
    const outcomes: string[] = []
    for (const asOf of ['2026-09-20T23:59:59Z', '2026-09-21T00:00:00Z', '2026-09-21T00:00:01Z']) {
      const ctx = ownerContext()
      const evidence = new InMemoryVerificationEvidence()
      const artifacts = new InMemoryVerificationArtifacts()
      const payload = { ...RESULT_PAYLOAD, time: asOf }
      const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload, validFrom: '2026-09-21T00:00:00Z' })
      const claim = buildClaim({ evidenceRef: ref, resultDigest, asOf })
      const manifest = buildInputManifest([ref])
      const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
      const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })
      const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)
      outcomes.push(result.failedChecks.includes('source_not_yet_valid') ? 'before' : result.verdict)
    }
    expect(outcomes).toEqual(['before', 'pass', 'pass'])
  })

  it('compares decimal strings exactly rather than through Number coercion', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: queryPayload })
    const claim = buildClaim({
      evidenceRef: ref,
      resultDigest,
      predicate: 'operating_hours',
      subject: 'I-04',
      value: '100.000000000000000002',
      unit: 'h',
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
      fieldRefPointer: '/table/columns/0',
      timePointer: '/table/rows/0/2',
    })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claim],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'claim', claimId: claim.claimId }],
    })
    const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('number_mismatch')
  })

  it('rejects a business assertion hidden in a V2 limitations string', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: queryPayload })
    const claim = buildClaim({
      evidenceRef: ref,
      resultDigest,
      predicate: 'operating_hours',
      subject: 'I-04',
      value: '100.000000000000000001',
      unit: 'h',
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
      fieldRefPointer: '/table/columns/0',
      timePointer: '/table/rows/0/2',
    })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claim],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'claim', claimId: claim.claimId }],
      limitations: ['I-04 does not need maintenance.'],
    })
    const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toEqual(['unverified_limitation'])
    expect(result.supportedClaimIds).toEqual([claim.claimId])
  })

  it('rejects a predicate pointer to a different field even when both boolean values match', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const payload = {
      resultKind: 'table',
      table: {
        columns: [
          { name: 'inspection_due', type: 'boolean', semanticFieldRef: 'inspection_due' },
          { name: 'inspection_exempt', type: 'boolean', semanticFieldRef: 'inspection_exempt' },
          { name: 'facility_id', type: 'string', semanticFieldRef: 'facility_id' },
        ],
        rows: [[true, true, 'T-02']],
      },
    }
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload })
    const assertionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10'
    const assertion: VerifiedAssertion = {
      assertionId,
      kind: 'boolean',
      subject: 'T-02',
      predicate: 'inspection_due',
      value: true,
      references: [{
        evidenceRef: ref,
        resultDigest,
        valuePointer: '/table/rows/0/0',
        subjectPointer: '/table/rows/0/2',
        fieldRefPointer: '/table/columns/1',
      }],
    }
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [],
      assertions: [assertion],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'assertion', assertionId }],
    })
    const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('predicate_mismatch')
    expect(result.supportedAssertionIds).toEqual([])
  })

  it('applies the same half-open validFrom boundary to typed boolean assertions', async () => {
    const outcomes: string[] = []
    for (const asOf of ['2026-09-20T23:59:59Z', '2026-09-21T00:00:00Z', '2026-09-21T00:00:01Z']) {
      const ctx = ownerContext()
      const evidence = new InMemoryVerificationEvidence()
      const artifacts = new InMemoryVerificationArtifacts()
      const payload = {
        resultKind: 'table',
        table: {
          columns: [
            { name: 'inspection_due', type: 'boolean', semanticFieldRef: 'inspection_due' },
            { name: 'facility_id', type: 'string', semanticFieldRef: 'facility_id' },
            { name: 'observed_at', type: 'timestamp', semanticFieldRef: 'observed_at' },
          ],
          rows: [[true, 'T-01', asOf]],
        },
      }
      const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload, validFrom: '2026-09-21T00:00:00Z' })
      const assertionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12'
      const assertion: VerifiedAssertion = {
        assertionId,
        kind: 'boolean',
        subject: 'T-01',
        predicate: 'inspection_due',
        asOf,
        value: true,
        references: [{
          evidenceRef: ref,
          resultDigest,
          valuePointer: '/table/rows/0/0',
          subjectPointer: '/table/rows/0/1',
          timePointer: '/table/rows/0/2',
          fieldRefPointer: '/table/columns/0',
        }],
      }
      const manifest = buildInputManifest([ref])
      const draft = buildDraft({
        evidenceManifestHash: manifest.digest,
        claims: [],
        assertions: [assertion],
        schemaVersion: 'answer-draft@2',
        blocks: [{ kind: 'assertion', assertionId }],
      })
      const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })
      const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)
      outcomes.push(result.failedChecks.includes('source_not_yet_valid') ? 'before' : result.verdict)
    }
    expect(outcomes).toEqual(['before', 'pass', 'pass'])
  })

  it('requires a source time pointer when a claim states an as-of time', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: queryPayload })
    const claim = buildClaim({
      evidenceRef: ref,
      resultDigest,
      predicate: 'operating_hours',
      subject: 'I-04',
      value: '100.000000000000000001',
      unit: 'h',
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
      fieldRefPointer: '/table/columns/0',
      references: [{
        evidenceRef: ref,
        resultDigest,
        valuePointer: '/table/rows/0/0',
        unitPointer: '/table/columns/0/unit',
        subjectPointer: '/table/rows/0/1',
        fieldRefPointer: '/table/columns/0',
      }],
    })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claim],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'claim', claimId: claim.claimId }],
    })
    const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('time_mismatch')
  })

  it('rejects V1 typed assertions because the legacy hash did not bind them', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const assertionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11'
    const assertion: VerifiedAssertion = {
      assertionId,
      kind: 'string',
      subject: RESULT_PAYLOAD.subject,
      predicate: 'facility_id',
      value: RESULT_PAYLOAD.subject,
      references: [{
        evidenceRef: ref,
        resultDigest,
        valuePointer: '/subject',
        subjectPointer: '/subject',
      }],
    }
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [], assertions: [assertion] })
    const { service } = buildService({ evidence, artifacts, policy: verificationPolicy({ semanticReview: 'disabled' }) })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('draft_hash_mismatch')
  })
})

describe('hard failure outranks a high probabilistic score (D7.4)', () => {
  it('blocks a wrong-unit claim even when JEV returns supported with probability 0.999', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest, unit: 'MWh' })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const decision = new FixedSemanticDecision('supported', 0.999)
    const { service } = buildService({ evidence, artifacts, decision })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('unit_mismatch')
    // The semantic review really ran and really said "supported" — the hard check still wins.
    expect(decision.calls).toHaveLength(1)
    expect(result.findings?.some((finding) => finding.axis === 'semantic')).toBe(false)
  })
})

describe('JEV never emits the explanation text (ADR-09, D7.4)', () => {
  const SENTINEL = 'SENTINEL_JEV_FREE_TEXT'

  it('uses a restricted template when JEV is unsupported and drops its free text', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({
      evidence,
      artifacts,
      decision: new ChattySemanticDecision('unsupported', SENTINEL),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('semantic_unsupported')
    const explanation = result.explanations?.[0]
    expect(explanation?.templateId).toContain('semantic_unsupported')
    expect(explanation?.message).not.toContain(SENTINEL)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  it('drops JEV free text on a passing claim too', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({
      evidence,
      artifacts,
      decision: new ChattySemanticDecision('supported', SENTINEL),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('pass')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })
})

describe('verdict binding and draft revision (D7.4, C6)', () => {
  async function registeredClaim() {
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const registered = await registerResult({ evidence, artifacts })
    return { evidence, artifacts, ...registered }
  }

  it('a revision produces a new draft hash and the old verdict cannot bind it', async () => {
    const ctx = ownerContext()
    const { evidence, artifacts, ref, resultDigest } = await registeredClaim()
    const manifest = buildInputManifest([ref])
    const claimV1 = buildClaim({ evidenceRef: ref, resultDigest })
    const draftV1 = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claimV1] })
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

    const verdictV1 = await verifyDraft(service, { runId: RUN_ID, draft: draftV1, inputManifest: manifest }, ctx)
    expect(verdictV1.verdict).toBe('pass')
    expect(verdictV1.draftHash).toBe(draftV1.contentHash)

    // A revision of the claim is a new draft with a new content hash.
    const claimV2 = buildClaim({ evidenceRef: ref, resultDigest, value: 13 })
    const draftV2 = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claimV2] })
    expect(draftV2.contentHash).not.toBe(draftV1.contentHash)

    const verdictV2 = await verifyDraft(service, { runId: RUN_ID, draft: draftV2, inputManifest: manifest }, ctx)
    expect(verdictV2.verdict).toBe('fail')
    expect(verdictV2.draftHash).toBe(draftV2.contentHash)
    // The old verdict bound the old hash, so it can never be reused for the revision.
    expect(verdictV1.draftHash).not.toBe(verdictV2.draftHash)
  })

  it('binds evidence_manifest_hash and policy_version and rejects a tampered draft body', async () => {
    const ctx = ownerContext()
    const { evidence, artifacts, ref, resultDigest } = await registeredClaim()
    const manifest = buildInputManifest([ref])
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

    const mismatched = buildDraft({
      evidenceManifestHash: sha256DigestOf('another-manifest'),
      claims: [claim],
    })
    const mismatchResult = await verifyDraft(service,
      { runId: RUN_ID, draft: mismatched, inputManifest: manifest },
      ctx,
    )
    expect(mismatchResult.verdict).toBe('fail')
    expect(mismatchResult.failedChecks).toContain('evidence_manifest_mismatch')

    // A body whose recomputed hash no longer matches its stored hash is rejected.
    const tampered = { ...draft, claims: [buildClaim({ evidenceRef: ref, resultDigest, value: 1 })] }
    const tamperedResult = await verifyDraft(service, { runId: RUN_ID, draft: tampered, inputManifest: manifest }, ctx)
    expect(tamperedResult.verdict).toBe('fail')
    expect(tamperedResult.failedChecks).toContain('draft_hash_mismatch')
  })
})

describe('no publication path (INV-09, C6)', () => {
  it('exposes no publish/findAnswer surface and no answer id on the verdict', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

    expect('publish' in service).toBe(false)
    expect('findAnswer' in service).toBe(false)
    expect('openLedger' in service).toBe(false)

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result).not.toHaveProperty('answerId')
    expect(result).not.toHaveProperty('publishedAt')
  })

  it('the verification sources contain no unverified-answer publication token', () => {
    const dir = fileURLToPath(new URL('../../packages/application/src/verification', import.meta.url))
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(`${dir}/${name}`, 'utf8'))
      .join('\n')
    expect(sources).not.toContain('unverified_answer')
    expect(sources).not.toContain('answer.published')
  })
})

describe('semantic decision state is run-bound and the adapter owns model attempts', () => {
  it('archives the original question, typed claims and hard-read evidence once per draft, then reuses its ref per claim', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const decision = new FixedSemanticDecision('supported')
    const { service, archivedStates } = buildService({ evidence, artifacts, decision })
    const claimA = buildClaim({ claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', evidenceRef: ref, resultDigest })
    const claimB = buildClaim({ claimId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', evidenceRef: ref, resultDigest })
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claimA, claimB],
    })
    const question = 'How many operating hours are recorded for this device?'

    const result = await verifyDraft(service, { runId: RUN_ID, question, draft, inputManifest: manifest }, ctx)

    expect(result.semanticReview).toEqual({ status: 'completed' })
    expect(result.verdict).toBe('pass')
    expect(archivedStates).toHaveLength(1)
    expect(archivedStates[0]).toMatchObject({
      schemaVersion: 'verification-semantic-state@1',
      runId: RUN_ID,
      resolvedProfileHash: ctx.resolvedProfileHash,
      question,
      draftHash: draft.contentHash,
      inputManifest: { manifestId: manifest.manifestId, revision: manifest.revision, digest: manifest.digest },
      claims: [{ claimId: claimA.claimId }, { claimId: claimB.claimId }],
      evidence: [{
        ref,
        availability: 'readable',
        envelope: { resultDigest },
        payload: RESULT_PAYLOAD,
      }],
      evidenceCoverage: { complete: true, referenceCount: 1, readableCount: 1 },
    })
    expect(decision.calls).toHaveLength(2)
    expect(decision.calls[0]?.stateRef).toEqual(decision.calls[1]?.stateRef)
    expect(decision.calls[0]?.stateRef.id).not.toBe(draft.contentHash)
  })

  it('archives verified typed assertions beside claims with their actual evidence payload', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const payload = {
      resultKind: 'table',
      table: {
        columns: [
          { name: 'operating_hours', type: 'decimal', unit: 'h', semanticFieldRef: 'operating_hours' },
          { name: 'asset_id', type: 'string', semanticFieldRef: 'asset_id' },
          { name: 'observed_at', type: 'timestamp', semanticFieldRef: 'observed_at' },
          { name: 'inspection_due', type: 'boolean', semanticFieldRef: 'inspection_due' },
        ],
        rows: [['100.000000000000000001', 'I-04', RESULT_PAYLOAD.time, false]],
      },
    }
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload })
    const claim = buildClaim({
      evidenceRef: ref,
      resultDigest,
      predicate: 'operating_hours',
      subject: 'I-04',
      value: '100.000000000000000001',
      unit: 'h',
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
      fieldRefPointer: '/table/columns/0',
      timePointer: '/table/rows/0/2',
    })
    const assertionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa31'
    const assertion: VerifiedAssertion = {
      assertionId,
      kind: 'boolean',
      subject: 'I-04',
      predicate: 'inspection_due',
      value: false,
      references: [{
        evidenceRef: ref,
        resultDigest,
        valuePointer: '/table/rows/0/3',
        subjectPointer: '/table/rows/0/1',
        fieldRefPointer: '/table/columns/3',
      }],
    }
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [claim],
      assertions: [assertion],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'claim', claimId: claim.claimId }, { kind: 'assertion', assertionId }],
    })
    const decision = new FixedSemanticDecision('supported')
    const { service, archivedStates } = buildService({ evidence, artifacts, decision })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('pass')
    expect(result.supportedAssertionIds).toEqual([assertionId])
    expect(archivedStates[0]).toMatchObject({
      claims: [{ claimId: claim.claimId, predicate: 'operating_hours' }],
      assertions: [{ assertionId, kind: 'boolean', predicate: 'inspection_due', value: false }],
      evidence: [{ ref, availability: 'readable', envelope: { resultDigest }, payload }],
      evidenceCoverage: { complete: true, referenceCount: 1, readableCount: 1 },
    })
    expect(decision.calls).toHaveLength(1)
  })

  it('marks missing state-provider configuration as not_run without calling DecisionPort and may pass deterministically', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const decision = new FixedSemanticDecision('supported')
    const { service, archivedStates } = buildService({ evidence, artifacts, decision, decisionStateRefProvider: null })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.semanticReview).toEqual({ status: 'not_run', reason: 'not_configured' })
    expect(result.verdict).toBe('pass')
    expect(decision.calls).toHaveLength(0)
    expect(archivedStates).toHaveLength(0)
  })

  it('requires the original question instead of substituting an internally generated prompt', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [buildClaim({ evidenceRef: ref, resultDigest })] })
    const decision = new FixedSemanticDecision('supported')
    const { service, archivedStates } = buildService({ evidence, artifacts, decision })

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.semanticReview).toEqual({ status: 'not_run', reason: 'not_configured' })
    expect(decision.calls).toHaveLength(0)
    expect(archivedStates).toHaveLength(0)
  })

  it('records disabled semantic review and never archives state or calls DecisionPort', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [buildClaim({ evidenceRef: ref, resultDigest })] })
    const decision = new FixedSemanticDecision('supported')
    const { service, archivedStates } = buildService({
      evidence,
      artifacts,
      decision,
      policy: verificationPolicy({ semanticReview: 'disabled' }),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.semanticReview).toEqual({ status: 'not_run', reason: 'disabled' })
    expect(result.verdict).toBe('pass')
    expect(decision.calls).toHaveLength(0)
    expect(archivedStates).toHaveLength(0)
  })

  it('propagates cancellation/deadline errors from DecisionPort without returning a verdict', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [buildClaim({ evidenceRef: ref, resultDigest })] })
    const cancellation = new DOMException('cancelled', 'AbortError')
    const deadline = new JevAdapterError('DEADLINE_EXCEEDED', 'controlled deadline')

    for (const failure of [cancellation, deadline]) {
      const decision: DecisionPort = { decide: () => Promise.reject(failure) }
      const { service } = buildService({ evidence, artifacts, decision })
      await expect(verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)).rejects.toBe(failure)
    }
  })

  it('propagates state archive failures instead of presenting deterministic verification as a JEV result', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [buildClaim({ evidenceRef: ref, resultDigest })] })
    const archiveFailure = new Error('state registry unavailable')
    const decision = new FixedSemanticDecision('supported')
    const { service } = buildService({
      evidence,
      artifacts,
      decision,
      decisionStateRefProvider: { archive: () => Promise.reject(archiveFailure) },
    })

    await expect(verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)).rejects.toBe(archiveFailure)
    expect(decision.calls).toHaveLength(0)
  })

  it('keeps multi-claim retries and a repaired draft on the same ledger with one reservation per adapter attempt', async () => {
    const server = await startJevServer()
    jevServers.push(server)
    const jevBudget = await jevBudgetHarness({ maxModelTokens: 2000 })
    const ctx = createToolContext({
      ...jevBudget.ctx,
      allowedResources: { ...jevBudget.ctx.allowedResources, resourceKinds: ['run', 'artifact', 'evidence'] },
    })
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const claimA = buildClaim({ claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', evidenceRef: ref, resultDigest })
    const claimB = buildClaim({ claimId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', evidenceRef: ref, resultDigest })
    const draftV1 = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claimA, claimB] })
    const archivedStates = new Map<string, { readonly runId: string; readonly resolvedProfileHash: string; readonly ref: ResourceRef; readonly state: JevActualState }>()
    const archives: { readonly draftHash: string; readonly ref: ResourceRef; readonly state: JevActualState }[] = []
    const stateRefProvider: DecisionStateRefProvider = {
      archive: async (request, archiveContext) => {
        if (request.runId !== archiveContext.runId || request.resolvedProfileHash !== archiveContext.resolvedProfileHash) {
          throw new Error('semantic state archive scope mismatch')
        }
        if (!isJevState(request.state)) throw new Error('semantic state is not JSON-compatible')
        const state = request.state
        const refValue: ResourceRef = {
          id: randomUUID(),
          version: '1.0.0',
          digest: jevActualStateDigest(state),
          kind: 'artifact',
        }
        archivedStates.set(refValue.id, {
          runId: request.runId,
          resolvedProfileHash: request.resolvedProfileHash,
          ref: refValue,
          state,
        })
        archives.push({ draftHash: stateDraftHash(state), ref: refValue, state })
        return refValue
      },
    }
    const decision = makeAdapter({
      server,
      fixture: 'flaky_503',
      harness: jevBudget,
      maxAttempts: 2,
      stateResolver: {
        resolve: (request, resolveContext) => {
          const entry = archivedStates.get(request.stateRef.id)
          if (
            entry === undefined ||
            entry.runId !== resolveContext.runId ||
            entry.resolvedProfileHash !== resolveContext.resolvedProfileHash ||
            entry.ref.id !== request.stateRef.id ||
            entry.ref.version !== request.stateRef.version ||
            entry.ref.digest !== request.stateRef.digest ||
            entry.ref.kind !== request.stateRef.kind
          ) return Promise.reject(new JevStateResolutionError('NOT_FOUND'))
          return Promise.resolve({ state: entry.state, resolvedRef: entry.ref, complete: true })
        },
      },
    })
    const { service } = buildService({
      evidence,
      artifacts,
      decision,
      modelRef: { modelId: PLATFORM_MODEL_ID, version: '1.0.0' },
      decisionStateRefProvider: stateRefProvider,
    })
    const question = 'How many operating hours are recorded for this device?'

    const first = await verifyDraft(service, { runId: RUN_ID, question, draft: draftV1, inputManifest: manifest }, ctx)
    const claimC = buildClaim({ claimId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', evidenceRef: ref, resultDigest })
    const draftV2 = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claimA, claimB, claimC] })
    const second = await verifyDraft(service, { runId: RUN_ID, question, draft: draftV2, inputManifest: manifest }, ctx)

    expect(first.semanticReview).toEqual({ status: 'completed' })
    expect(second.semanticReview).toEqual({ status: 'completed' })
    expect(archives).toHaveLength(2)
    expect(archives[0]?.draftHash).toBe(draftV1.contentHash)
    expect(archives[1]?.draftHash).toBe(draftV2.contentHash)
    expect(archives[0]?.ref.id).not.toBe(archives[1]?.ref.id)
    expect(archives[0]?.state).toMatchObject({
      question,
      draftHash: draftV1.contentHash,
      claims: [{ claimId: claimA.claimId }, { claimId: claimB.claimId }],
      evidence: [{ ref, availability: 'readable', payload: RESULT_PAYLOAD }],
    })
    expect(archives[1]?.state).toMatchObject({
      question,
      draftHash: draftV2.contentHash,
      claims: [{ claimId: claimA.claimId }, { claimId: claimB.claimId }, { claimId: claimC.claimId }],
    })
    expect(server.requests).toHaveLength(6)
    for (const request of server.requests.slice(0, 3)) expect(request.body['state']).toEqual(archives[0]?.state)
    for (const request of server.requests.slice(3)) expect(request.body['state']).toEqual(archives[1]?.state)
    const reservations = await jevReservationsOf(jevBudget)
    expect(reservations).toHaveLength(6)
    expect(new Set(reservations.map((reservation) => reservation.reservationId)).size).toBe(6)
    expect(reservations.every((reservation) => reservation.ledgerId === jevBudget.ledgerId)).toBe(true)
    expect(reservations.map((reservation) => reservation.status)).toEqual([
      'failed', 'settled', 'settled', 'settled', 'settled', 'settled',
    ])
    expect((await jevRemainingOf(jevBudget)).remaining.tokensRemaining).toBe(2000 - 125)
  })

  it('does not convert JEV settlement failures into a successful verification', async () => {
    const server = await startJevServer()
    jevServers.push(server)
    const jevBudget = await jevBudgetHarness({ maxModelTokens: 1000 })
    const ctx = createToolContext({
      ...jevBudget.ctx,
      allowedResources: { ...jevBudget.ctx.allowedResources, resourceKinds: ['run', 'artifact', 'evidence'] },
    })
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const stateRefs = new Map<string, JevActualState>()
    const stateRefProvider: DecisionStateRefProvider = {
      archive: async (request) => {
        if (!isJevState(request.state)) throw new Error('semantic state is not JSON-compatible')
        const refValue: ResourceRef = {
          id: randomUUID(),
          version: '1.0.0',
          digest: jevActualStateDigest(request.state),
          kind: 'artifact',
        }
        stateRefs.set(refValue.id, request.state)
        return refValue
      },
    }
    const innerBudget = jevBudget.budget
    const budgetWithFailedCompletedSettlement = new Proxy(innerBudget, {
      get(target, property, receiver) {
        if (property === 'settle') {
          return async (settlement: Parameters<typeof innerBudget.settle>[0], settlementContext: ToolContext) => {
            if (settlement.status === 'completed') throw new Error('controlled budget settlement failure')
            return innerBudget.settle(settlement, settlementContext)
          }
        }
        const member = Reflect.get(target, property, receiver)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const decision = makeAdapter({
      server,
      fixture: 'choice',
      harness: { ...jevBudget, budget: budgetWithFailedCompletedSettlement },
      stateResolver: {
        resolve: (request) => {
          const state = stateRefs.get(request.stateRef.id)
          if (state === undefined) return Promise.reject(new JevStateResolutionError('NOT_FOUND'))
          return Promise.resolve({ state, resolvedRef: request.stateRef, complete: true })
        },
      },
    })
    const { service } = buildService({
      evidence,
      artifacts,
      decision,
      modelRef: { modelId: PLATFORM_MODEL_ID, version: '1.0.0' },
      decisionStateRefProvider: stateRefProvider,
    })

    await expect(verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx))
      .rejects.toMatchObject({ message: 'controlled budget settlement failure' })
    expect(await jevReservationsOf(jevBudget)).toMatchObject([
      { status: 'usage_unknown', usageUnknown: true },
    ])
  })
})

describe('missing evidence, unbound claims and unavailable JEV (D7.4, C2)', () => {
  it('reports evidence that is not in the manifest as missing', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const orphan = { id: 'a2222222-2222-4222-8222-222222222222', version: '1.0.0', digest: sha256DigestOf('orphan'), kind: 'evidence' as const }
    const claim = buildClaim({ evidenceRef: orphan, resultDigest: sha256DigestOf('orphan-result') })
    const manifest = buildInputManifest([])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('evidence_not_found')
    expect(result.missingEvidence).toEqual([orphan.id])
  })

  it('rejects a claim with no binding and a draft with no claims', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const manifest = buildInputManifest([])
    const decision = new FixedSemanticDecision('supported')
    const { service } = buildService({ evidence, artifacts, decision })

    const unbound = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [buildClaim({ references: [] })],
    })
    const unboundResult = await verifyDraft(service, { runId: RUN_ID, draft: unbound, inputManifest: manifest }, ctx)
    expect(unboundResult.failedChecks).toContain('unbound_claim')

    const empty = buildDraft({ evidenceManifestHash: manifest.digest, claims: [] })
    const callsBeforeEmptyDraft = decision.calls.length
    const emptyResult = await verifyDraft(service, { runId: RUN_ID, draft: empty, inputManifest: manifest }, ctx)
    expect(emptyResult.failedChecks).toContain('missing_claims')
    expect(emptyResult.semanticReview).toEqual({ status: 'not_run', reason: 'no_claims' })
    expect(decision.calls).toHaveLength(callsBeforeEmptyDraft)
  })

  it('flags a stale source and honours the deterministic JEV fallback', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, validTo: '2026-01-01T00:00:00Z' })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({
      evidence,
      artifacts,
      decision: new FallbackDecision(),
      policy: verificationPolicy({ onJevUnavailable: 'deterministic' }),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.failedChecks).toContain('stale_source')
    expect(result.semanticReview).toEqual({ status: 'not_run', reason: 'provider_fallback' })
    expect(result.verdict).toBe('fail')
    // The deterministic fallback adds no semantic finding and fabricates no calibrated value.
    expect(result.findings?.some((finding) => finding.axis === 'semantic')).toBe(false)
  })

  it('records semantic_unavailable when the policy asks to clarify', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const claim = buildClaim({ evidenceRef: ref, resultDigest })
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({
      evidence,
      artifacts,
      decision: new FallbackDecision(),
      policy: verificationPolicy({ semanticReview: 'optional', onJevUnavailable: 'clarify' }),
    })

    const result = await verifyDraft(service, { runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('semantic_unavailable')
    expect(result.semanticReview).toEqual({ status: 'not_run', reason: 'provider_fallback' })
    // The provider's own free-text fallback reason never reaches a finding or an explanation.
    expect(JSON.stringify(result)).not.toContain('provider unavailable')
  })
})
