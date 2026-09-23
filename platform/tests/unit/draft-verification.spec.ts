import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DraftVerificationService, answerDraftContentHash } from '@ontology/application'
import type {
  DecisionPort,
  EvidenceStorePort,
  VerificationPolicy,
  VerifiedAssertion,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type { VerificationArtifactStore } from '@ontology/application'
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
  buildBudget,
  buildClaim,
  buildDraft,
  buildEvidence,
  buildInputManifest,
  modelRef,
  openRunLedger,
  ownerContext,
  verificationPolicy,
} from './verification-fixtures'
import type { BudgetHarness } from './verification-fixtures'

interface HarnessOptions {
  readonly decision?: DecisionPort
  readonly policy?: VerificationPolicy
  readonly budget?: BudgetHarness
  readonly evidence?: EvidenceStorePort
  readonly artifacts?: VerificationArtifactStore
}

function buildService(options: HarnessOptions = {}) {
  const evidence = options.evidence ?? new InMemoryVerificationEvidence()
  const artifacts = options.artifacts ?? new InMemoryVerificationArtifacts()
  const service = new DraftVerificationService({
    evidence,
    artifacts,
    policy: options.policy ?? verificationPolicy(),
    modelRef: modelRef(),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
    ...(options.budget === undefined
      ? {}
      : { budget: { ledger: options.budget.service, ledgerId: options.budget.ledgerId } }),
    now: () => NOW,
  })
  return { service, evidence, artifacts }
}

function typedDraft(assertions: readonly VerifiedAssertion[], manifest: WorkflowInputManifest) {
  const schemaVersion = 'answer-draft@2' as const
  const blocks = assertions.map((assertion) => ({ kind: 'assertion', assertionId: assertion.assertionId }))
  const limitations: readonly string[] = []
  return {
    ...buildDraft({ evidenceManifestHash: manifest.digest, claims: [], blocks }),
    schemaVersion,
    assertions,
    limitations,
    contentHash: answerDraftContentHash(RUN_ID, blocks, manifest.digest, [], assertions, { schemaVersion, limitations }),
  }
}

/** Register one archived result payload plus its evidence envelope. */
async function registerResult(input: {
  readonly evidence: InMemoryVerificationEvidence
  readonly artifacts: InMemoryVerificationArtifacts
  readonly payload?: unknown
  readonly validTo?: string
}) {
  const payloadRef = input.artifacts.put(BLOB_ID, input.payload ?? RESULT_PAYLOAD)
  const envelope = buildEvidence({
    payloadRef,
    resultDigest: payloadRef.digest,
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
  })
  const record = await input.evidence.record(
    { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    envelope,
  )
  return { record, ref: record.evidenceRef, resultDigest: payloadRef.digest }
}

describe('structured claim binding (D7.4, US-021)', () => {
  it('accepts an exact canonical SQL DECIMAL string without rounding away a mismatch', async () => {
    const verifyValue = async (value: string) => {
      const evidence = new InMemoryVerificationEvidence()
      const artifacts = new InMemoryVerificationArtifacts()
      const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: { ...RESULT_PAYLOAD, value } })
      const claim = buildClaim({ evidenceRef: ref, resultDigest, value: 12.5 })
      const manifest = buildInputManifest([ref])
      const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
      const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })
      return service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ownerContext())
    }
    const result = await verifyValue('12.5000000000')
    expect(result.verdict).toBe('pass')
    const bad = await verifyValue('12.5000000001')
    expect(bad.verdict).toBe('fail')
    expect(bad.failedChecks).toContain('number_mismatch')
  })

  it('rejects a claimed source time when its evidence binding omits the time pointer', async () => {
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const original = buildClaim({ evidenceRef: ref, resultDigest })
    const binding = original.references[0]
    if (binding === undefined) throw new Error('claim fixture has no binding')
    const withoutTimePointer = {
      evidenceRef: binding.evidenceRef,
      resultDigest: binding.resultDigest,
      valuePointer: binding.valuePointer,
      unitPointer: binding.unitPointer,
      subjectPointer: binding.subjectPointer,
    }
    const claim = { ...original, references: [withoutTimePointer] }
    const manifest = buildInputManifest([ref])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })
    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ownerContext())
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('time_mismatch')
  })

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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

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

      const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

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

    const verdictV1 = await service.verify({ runId: RUN_ID, draft: draftV1, inputManifest: manifest }, ctx)
    expect(verdictV1.verdict).toBe('pass')
    expect(verdictV1.draftHash).toBe(draftV1.contentHash)

    // A revision of the claim is a new draft with a new content hash.
    const claimV2 = buildClaim({ evidenceRef: ref, resultDigest, value: 13 })
    const draftV2 = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claimV2] })
    expect(draftV2.contentHash).not.toBe(draftV1.contentHash)

    const verdictV2 = await service.verify({ runId: RUN_ID, draft: draftV2, inputManifest: manifest }, ctx)
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
    const mismatchResult = await service.verify(
      { runId: RUN_ID, draft: mismatched, inputManifest: manifest },
      ctx,
    )
    expect(mismatchResult.verdict).toBe('fail')
    expect(mismatchResult.failedChecks).toContain('evidence_manifest_mismatch')

    // A body whose recomputed hash no longer matches its stored hash is rejected.
    const tampered = { ...draft, claims: [buildClaim({ evidenceRef: ref, resultDigest, value: 1 })] }
    const tamperedResult = await service.verify({ runId: RUN_ID, draft: tampered, inputManifest: manifest }, ctx)
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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)
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

describe('shared budget is never reset (ADR-14, D7.2)', () => {
  it('draws each repair from the same ledger without opening a new one', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts })
    const manifest = buildInputManifest([ref])
    const budget = buildBudget()
    await openRunLedger(budget, ctx)
    const decision = new FixedSemanticDecision('supported')
    const { service } = buildService({ evidence, artifacts, decision, budget })

    const draftV1 = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [buildClaim({ evidenceRef: ref, resultDigest, unit: 'MWh' })],
    })
    const first = await service.verify({ runId: RUN_ID, draft: draftV1, inputManifest: manifest }, ctx)
    expect(first.verdict).toBe('fail')

    const draftV2 = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [buildClaim({ evidenceRef: ref, resultDigest })],
    })
    const second = await service.verify({ runId: RUN_ID, draft: draftV2, inputManifest: manifest }, ctx)
    expect(second.verdict).toBe('pass')

    const ledger = await budget.store.getLedger(
      { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      budget.ledgerId,
      ctx,
    )
    // Two verification passes on one ledger: the repair never reset the counter.
    expect(ledger?.consumed.modelTokens).toBe(128)
    expect(ledger?.ledgerId).toBe(budget.ledgerId)
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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('evidence_not_found')
    expect(result.missingEvidence).toEqual([orphan.id])
  })

  it('rejects a claim with no binding and a draft with no claims', async () => {
    const ctx = ownerContext()
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const manifest = buildInputManifest([])
    const { service } = buildService({ evidence, artifacts, decision: new FixedSemanticDecision('supported') })

    const unbound = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [buildClaim({ references: [] })],
    })
    const unboundResult = await service.verify({ runId: RUN_ID, draft: unbound, inputManifest: manifest }, ctx)
    expect(unboundResult.failedChecks).toContain('unbound_claim')

    const empty = buildDraft({ evidenceManifestHash: manifest.digest, claims: [] })
    const emptyResult = await service.verify({ runId: RUN_ID, draft: empty, inputManifest: manifest }, ctx)
    expect(emptyResult.failedChecks).toContain('missing_claims')
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

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.failedChecks).toContain('stale_source')
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
      policy: verificationPolicy({ onJevUnavailable: 'clarify' }),
    })

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('semantic_unavailable')
    // The provider's own free-text fallback reason never reaches a finding or an explanation.
    expect(JSON.stringify(result)).not.toContain('provider unavailable')
  })
})

describe('versioned typed assertions', () => {
  it('accepts a source-bound enum and rejects a changed subject even with a fresh draft hash', async () => {
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: { facility: 'road-1', state: 'pending' } })
    const manifest = buildInputManifest([ref])
    const assertion: VerifiedAssertion = {
      assertionId: '44444444-4444-4444-8444-444444444444', kind: 'enum',
      subject: 'road-1', predicate: 'inspection_state', value: 'pending',
      references: [{ evidenceRef: ref, resultDigest, subjectPointer: '/facility', valuePointer: '/state' }],
    }
    const { service } = buildService({ evidence, artifacts })
    const valid = await service.verify({ runId: RUN_ID, draft: typedDraft([assertion], manifest), inputManifest: manifest }, ownerContext())
    expect(valid.verdict).toBe('pass')

    const forged: VerifiedAssertion = { ...assertion, subject: 'road-2' }
    const rejected = await service.verify({ runId: RUN_ID, draft: typedDraft([forged], manifest), inputManifest: manifest }, ownerContext())
    expect(rejected.verdict).toBe('fail')
    expect(rejected.failedChecks).toContain('assertion_mismatch')
  })

  it('binds a document quote to archived text, version, digest and locator', async () => {
    const text = 'Inspect twice each year.'
    const documentRef = { id: '55555555-5555-4555-8555-555555555555', version: '1.0.0', digest: sha256DigestOf(text), kind: 'document' as const }
    const locator = { kind: 'offset' as const, startOffset: 0, endOffset: text.length }
    const digest = sha256DigestOf(text)
    const evidence = new InMemoryVerificationEvidence()
    const artifacts = new InMemoryVerificationArtifacts()
    const { ref, resultDigest } = await registerResult({ evidence, artifacts, payload: { quotes: [{ documentRef, locator, text, textDigest: digest, quoteDigest: digest }] } })
    const manifest = buildInputManifest([ref])
    const assertion: VerifiedAssertion = {
      assertionId: '66666666-6666-4666-8666-666666666666', kind: 'document_quote', subject: documentRef.id,
      predicate: 'source_quote', quote: text, documentRef, locator, textDigest: digest, quoteDigest: digest, precision: 'exact',
      references: [{ evidenceRef: ref, resultDigest, valuePointer: '/quotes/0/text', subjectPointer: '/quotes/0/documentRef/id', documentPointer: '/quotes/0/documentRef', locatorPointer: '/quotes/0/locator', textDigestPointer: '/quotes/0/textDigest', quoteDigestPointer: '/quotes/0/quoteDigest' }],
    }
    const { service } = buildService({ evidence, artifacts })
    const verify = (candidate: VerifiedAssertion) => service.verify({ runId: RUN_ID, draft: typedDraft([candidate], manifest), inputManifest: manifest }, ownerContext())
    expect((await verify(assertion)).verdict).toBe('pass')

    const changedQuote: VerifiedAssertion = { ...assertion, quote: 'Inspect once each year.' }
    expect((await verify(changedQuote)).failedChecks).toContain('document_quote_mismatch')
    const changedLocator: VerifiedAssertion = { ...assertion, locator: { kind: 'offset', startOffset: 1, endOffset: text.length } }
    expect((await verify(changedLocator)).failedChecks).toContain('document_quote_mismatch')
    const changedDocument: VerifiedAssertion = { ...assertion, documentRef: { ...documentRef, version: '2.0.0' } }
    expect((await verify(changedDocument)).failedChecks).toContain('document_quote_mismatch')
    const changedResult: VerifiedAssertion = { ...assertion, references: [{ ...assertion.references[0]!, resultDigest: sha256DigestOf('other-result') }] }
    expect((await verify(changedResult)).failedChecks).toContain('result_digest_mismatch')

    const changedLimitations = { ...typedDraft([assertion], manifest), limitations: ['unsupported extra conclusion'] }
    const forgedBody = await service.verify({ runId: RUN_ID, draft: changedLimitations, inputManifest: manifest }, ownerContext())
    expect(forgedBody.failedChecks).toContain('draft_hash_mismatch')
  })
})
