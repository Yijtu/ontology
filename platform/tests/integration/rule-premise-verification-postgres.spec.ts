import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresEvidenceStore, PostgresMaterializationStore } from '@ontology/adapter-control-postgres'
import { DocumentSpanReader } from '@ontology/adapter-extraction-document'
import { createBlobArtifactWriter } from '@ontology/app-api'
import { answerDraftContentHash, DraftVerificationService, TypedEvidenceDraftWriter, ruleDerivationValidator } from '@ontology/application'
import { ArchivedRulePremiseReplayVerifier, IncrementalMaterializer, MaterializedRuleDerivationEvidenceProducer, sha256DigestOf, publishedRuleDependencyRef } from '@ontology/semantic-engine'
import { isRecord } from '@ontology/contracts'
import type { EvidenceEnvelope, RuleComputationArtifact } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { buildInputManifest, RUN_ID, verificationPolicy } from '../unit/verification-fixtures'
import { INDUSTRIAL_RULES, INDUSTRIAL_TEXT } from '../fixtures/competency-questions/assets'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { publishedRuleChainHarness } from './published-rule-chain-harness'

let harness: JobDbHarness
let database: ControlPostgresDatabase
beforeAll(async () => { harness = await startJobDatabase(); database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 }) }, 120_000)
afterAll(async () => { await database?.close(); await harness?.stop() })

describe('independent actual published premise verification (#264)', () => {
  it('replays actual frozen pack/extracted chains and alternative sources; rejects forged facts, declarations, spans, result, scope and withdrawals', async () => {
    const scope = await createJobScope(harness.adminClient, 'actual-premise-verification')
    const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    const p = await publishedRuleChainHarness(database, harness.appUrl, scope, ctx)
    try {
      const first = await p.importSupport('A-01', 120), second = await p.importSupport('A-01', 120, false, first.entityId)
      const leaf = await p.publishExtractedRule(INDUSTRIAL_RULES[0])
      const mid = await p.publishExtractedRule(INDUSTRIAL_RULES[1], [publishedRuleDependencyRef(leaf, scope.scopeRef, p.definition.ref)])
      await p.publishExtractedRule(INDUSTRIAL_RULES[2], [publishedRuleDependencyRef(mid, scope.scopeRef, p.definition.ref)], `${INDUSTRIAL_TEXT}\nSecond reviewed version reaffirms the same third-layer policy.`)
      const materialization = new PostgresMaterializationStore(database), evidence = new PostgresEvidenceStore(database)
      const materializer = new IncrementalMaterializer({ publishedSource: p.source, materialization })
      await materializer.applyChange({ changeId: randomUUID(), scopeRef: scope.scopeRef, recordedSeq: '1', recordedAt: new Date().toISOString(), kind: 'assertion_published',
        logicalAssertionId: first.candidate.candidateId, predicate: 'hours', subjectEntityId: first.entityId, validity: { validFrom: new Date(Date.now() - 60_000).toISOString() } }, ctx)
      const slices = await materialization.readSlices(scope.scopeRef, { asOfRecordedSeq: '1', limit: 100 }, ctx)
      const artifact = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).find((row) => row.ruleId === 'layer-three' && row.subjectEntityId === first.entityId && row.applicability.state === 'applicable')
      if (artifact?.validAt === undefined || artifact.asOfRecordedSeq === undefined) throw new Error('missing exact actual top-layer artifact')
      expect(artifact.premiseInput?.declarations).toHaveLength(6)
      expect(artifact.factRefs.map((fact) => fact.sourceStatementId)).toEqual(expect.arrayContaining([first.candidate.candidateId, second.candidate.candidateId]))
      const spans = new DocumentSpanReader({ blobs: p.blobs, store: p.parses })
      const artifacts = createBlobArtifactWriter(p.blobs)
      const deps = { materialization, evidence, artifacts: p.blobs, publications: p.publication, candidates: p.instances, identity: p.identities, documentParses: p.parses, documentSpans: spans, publishedRules: p.packReader }
      const producer = new MaterializedRuleDerivationEvidenceProducer({ ...deps, artifacts, componentRef: { id: 'actual-premise-producer', version: '1.0.0', digest: sha256DigestOf('actual-premise-producer') } })
      const recordFor = (selected: RuleComputationArtifact) => producer.record({ scopeRef: scope.scopeRef, ruleRef: selected.ruleRef, definitionRef: selected.definitionRef, objectId: selected.objectId,
        subjectEntityId: selected.subjectEntityId, validAt: selected.validAt ?? '', asOfRecordedSeq: selected.asOfRecordedSeq ?? '', observedAt: new Date().toISOString(), sourceSnapshots: [], dataMode: 'synthetic' }, ctx)
      const record = await recordFor(artifact)
      const write = async (ref: typeof record.evidenceRef) => {
        const manifest = buildInputManifest([ref])
        const result = await new TypedEvidenceDraftWriter({ evidence, artifacts: p.blobs }).writeDraft({ runId: RUN_ID, question: 'Actual maintenance judgement', inputManifest: manifest, deficits: [], attempt: 1,
          remainingBudget: { deadline: '2030-01-01T00:00:00Z', toolCallsRemaining: 100, repairAttemptsRemaining: 4, parallelToolLimit: 4, tokensRemaining: 1000 } }, ctx)
        return { draft: result.draft, manifest }
      }
      const verifier = (historical = false) => new DraftVerificationService({ evidence, artifacts: p.blobs, policy: verificationPolicy({ semanticReview: 'disabled' }), now: () => artifact.validAt ?? '',
        rulePremises: new ArchivedRulePremiseReplayVerifier({ ...deps, ...(historical ? { readMode: 'published_snapshot' as const } : {}) }) })
      const original = await write(record.evidenceRef)
      const assertion = original.draft.assertions?.[0]
      expect(assertion?.kind).toBe('rule_judgement')
      if (assertion?.kind !== 'rule_judgement') throw new Error('missing typed rule judgement')
      expect(assertion.premiseRefs.length).toBeGreaterThan(1)
      expect((await verifier().verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('pass')
      const extracted = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).find((row) => row.ruleId === 'extracted-layer-three' && row.subjectEntityId === first.entityId && row.applicability.state === 'applicable')
      if (extracted === undefined) throw new Error('missing actual extracted dependency chain')
      const extractedDraft = await write((await recordFor(extracted)).evidenceRef)
      expect((await verifier().verify({ runId: RUN_ID, draft: extractedDraft.draft, inputManifest: extractedDraft.manifest }, ctx)).verdict).toBe('pass')
      await p.publishExtractedRule(INDUSTRIAL_RULES[2], [publishedRuleDependencyRef(mid, scope.scopeRef, p.definition.ref)])
      expect((await verifier().verify({ runId: RUN_ID, draft: extractedDraft.draft, inputManifest: extractedDraft.manifest }, ctx)).verdict).toBe('fail')
      expect((await verifier(true).verify({ runId: RUN_ID, draft: extractedDraft.draft, inputManifest: extractedDraft.manifest }, ctx)).verdict).toBe('pass')
      // The independent P1 pack binding remains current when an unrelated extracted head changes.
      expect((await verifier().verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('pass')
      if (record.envelope.payloadRef === undefined) throw new Error('missing archived rule payload ref')
      const bytes = await p.blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: record.envelope.payloadRef }, ctx)
      const baseline: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!isRecord(baseline)) throw new Error('missing archived payload')
      const validity = ruleDerivationValidator(new ArchivedRulePremiseReplayVerifier(deps))
      expect((await validity.validate({ record, payload: baseline, now: new Date().toISOString(), ctx })).state).toBe('current')
      const forge = async (change: (payload: Record<string, unknown>, inner: Record<string, unknown>) => void) => {
        const payload = structuredClone(baseline), inner = payload['artifact']
        if (!isRecord(inner)) throw new Error('missing artifact')
        change(payload, inner)
        const stored = await artifacts.putBytes({ scopeRef: scope.scopeRef, content: new TextEncoder().encode(JSON.stringify(payload)), mediaType: 'application/json' }, ctx)
        const { integrity: discarded, ...body } = record.envelope
        void discarded
        const clean: Omit<EvidenceEnvelope, 'integrity'> = { ...body, evidenceId: randomUUID(), payloadRef: stored.blobRef, resultDigest: stored.contentDigest }
        const fake = await evidence.record(scope.scopeRef, { ...clean, integrity: { algorithm: 'sha256', digest: sha256DigestOf(clean), verifiedAt: new Date().toISOString() } }, ctx)
        const drafted = await write(fake.evidenceRef)
        return verifier().verify({ runId: RUN_ID, draft: drafted.draft, inputManifest: drafted.manifest }, ctx)
      }
      for (const mutation of ['fact', 'declaration', 'result', 'scope', 'upstream', 'span', 'ruleRef', 'premiseRef'] as const) {
        const result = await forge((payload, inner) => {
          const snapshot = inner['premiseInput']
          if (!isRecord(snapshot)) throw new Error('missing actual premise snapshot')
          if (mutation === 'fact' && Array.isArray(snapshot['facts']) && isRecord(snapshot['facts'][0])) snapshot['facts'][0]['value'] = false
          if (mutation === 'declaration' && Array.isArray(snapshot['declarations']) && isRecord(snapshot['declarations'][0])) snapshot['declarations'][0]['expression'] = { op: 'compare', attributeId: 'exempt', operator: 'eq', value: true, spans: [] }
          if (mutation === 'upstream' && Array.isArray(snapshot['declarations'])) snapshot['declarations'].pop()
          if (mutation === 'result') inner['applicability'] = { state: 'not_applicable', conditionState: 'false', exceptionStates: [], positiveSupport: false }
          if (mutation === 'scope') inner['scopeRef'] = { tenantId: randomUUID(), spaceId: scope.spaceId }
          if (mutation === 'ruleRef') inner['ruleRef'] = { ...artifact.ruleRef, digest: sha256DigestOf('wrong rule version') }
          if (mutation === 'premiseRef') payload['premiseRefs'] = []
          if (mutation === 'span' && Array.isArray(payload['sourceEvidenceMappings']) && isRecord(payload['sourceEvidenceMappings'][0])) payload['sourceEvidenceMappings'][0]['sourceSpan'] = { locator: { kind: 'offset', startOffset: 1, endOffset: 2 } }
          // Rehash a fabricated result too: a self-consistent archive still is not authority.
          inner['computationDigest'] = sha256DigestOf({ inputDigest: inner['inputDigest'], ruleRef: inner['ruleRef'], instanceKey: inner['instanceKey'], validAt: inner['validAt'], asOfRecordedSeq: inner['asOfRecordedSeq'], applicability: inner['applicability'], factRefs: inner['factRefs'] })
        })
        expect(result.verdict, mutation).toBe('fail')
      }
      const omitted = { ...assertion, premiseRefs: [] }
      const draft = { ...original.draft, assertions: [omitted], contentHash: answerDraftContentHash(RUN_ID, original.draft.blocks, original.draft.evidenceManifestHash, original.draft.claims ?? [], [omitted], { schemaVersion: 'answer-draft@2', limitations: original.draft.limitations }) }
      expect((await verifier().verify({ runId: RUN_ID, draft, inputManifest: original.manifest }, ctx)).failedChecks).toContain('rule_premise_missing')
      const wrongVerdict = { ...assertion, value: 'false' as const }
      const wrongDraft = { ...original.draft, assertions: [wrongVerdict], contentHash: answerDraftContentHash(RUN_ID, original.draft.blocks, original.draft.evidenceManifestHash, original.draft.claims ?? [], [wrongVerdict], { schemaVersion: 'answer-draft@2', limitations: original.draft.limitations }) }
      expect((await verifier().verify({ runId: RUN_ID, draft: wrongDraft, inputManifest: original.manifest }, ctx)).failedChecks).toContain('rule_judgement_mismatch')
      const service = p.saved.get('service')
      if (service === undefined || service.payload.conclusion === undefined) throw new Error('missing real rule approval')
      await p.rules.editRuleCandidate(p.asset.workspaceId, { candidateId: service.candidateId, expectedRevision: '2', reason: 'unreviewed version two proposal', idempotencyKey: `future-rule-${randomUUID()}`,
        displayName: 'future service', businessMeaning: 'future proposal', suggestedReason: 'human proposal only', ruleId: 'service', applicability: service.payload.applicability,
        condition: { op: 'range', attributeId: 'hours', min: 999, unitCode: 'h', spans: service.payload.condition.spans }, exceptions: service.payload.exceptions, conclusion: service.payload.conclusion,
        ruleDependencies: [], sourceRefs: service.sourceRefs, sourceSpans: service.sourceSpans }, ctx.principal.subjectId, ctx)
      expect((await verifier().verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('pass')
      await p.publication.appendReview(scope.scopeRef, { expectedRevision: '1', draft: { candidateId: service.candidateId, reviewId: randomUUID(), decision: 'reject', contentDigest: service.contentDigest, reason: 'current P1 withdrawn', evidenceRefs: [], actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() } }, ctx)
      expect((await verifier().verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('fail')
      expect((await verifier(true).verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('pass')
      await p.publisher.reviseStatement({ statementId: first.candidate.candidateId, kind: 'retraction', reason: 'source withdrawn after archiving', expectedRevision: '1', idempotencyKey: `withdraw-${randomUUID()}` }, ctx)
      expect((await validity.validate({ record, payload: baseline, now: new Date().toISOString(), ctx })).state).toBe('blocked')
      expect((await verifier().verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('fail')
      expect((await verifier(true).verify({ runId: RUN_ID, draft: original.draft, inputManifest: original.manifest }, ctx)).verdict).toBe('pass')
    } finally { await p.close() }
  }, 180_000)
})
