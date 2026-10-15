import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256DigestOf } from '@ontology/core'
import {
  PublicationValidityEngine,
  defaultPublicationEvidenceValidators,
} from '@ontology/application'
import type { PublicationEvidenceValidator, VerificationArtifactStore } from '@ontology/application'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  EvidenceEnvelope,
  EvidenceKind,
  EvidenceRecord,
  EvidenceStorePort,
  PublicationDependencyPin,
  PublicationPolicyReportRequirement,
  PublicationTableVerificationRequirement,
  ResourceRef,
  ScopeRef,
  TableVerificationReceipt,
  TableVerificationReceiptStore,
  TaskPolicyReportStore,
  TaskValidationPolicyReport,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { SCOPE_A, toolContext } from './verification-fixtures'

const NOW = '2026-09-21T00:00:00Z'
const RUN_ID = '33333333-3333-4333-8333-333333333333'

function context(): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_ID)
}

function refFor(record: EvidenceRecord): ResourceRef {
  return record.evidenceRef
}

/** A blob store that hashes the exact archived bytes, like the real local blob adapter. */
class Artifacts implements VerificationArtifactStore {
  readonly #payloads = new Map<string, Uint8Array>()

  put(blobId: Uuid, payload: unknown): ResourceRef {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    this.#payloads.set(blobId, bytes)
    return { id: blobId, version: '1.0.0', digest: sha256DigestOf(new TextDecoder().decode(bytes)), kind: 'artifact' }
  }

  overwrite(blobId: Uuid, raw: string): void {
    this.#payloads.set(blobId, new TextEncoder().encode(raw))
  }

  getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    const bytes = this.#payloads.get(request.blobRef.id)
    if (bytes === undefined) return Promise.reject(new Error('blob not found'))
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest: request.blobRef.digest,
      mediaType: 'application/json',
      byteSize: bytes.byteLength,
      integrityVerified: true,
    })
  }

  readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const bytes = this.#payloads.get(request.blobRef.id)
    return bytes === undefined ? Promise.reject(new Error('blob not found')) : Promise.resolve(bytes)
  }
}

class Evidence implements EvidenceStorePort {
  readonly records = new Map<string, EvidenceRecord>()

  async record(scopeRef: ScopeRef, envelope: EvidenceEnvelope): Promise<EvidenceRecord> {
    void scopeRef
    const stored: EvidenceRecord = {
      evidenceRef: { id: envelope.evidenceId, version: '1.0.0', digest: envelope.integrity.digest, kind: 'evidence' },
      envelope,
      envelopeDigest: envelope.integrity.digest,
      revision: String(this.records.size + 1),
      recordedAt: envelope.observedAt,
    }
    this.records.set(stored.evidenceRef.id, stored)
    return stored
  }

  get(_scopeRef: ScopeRef, evidenceId: Uuid): Promise<EvidenceRecord | undefined> {
    return Promise.resolve(this.records.get(evidenceId))
  }

  listByRun(): Promise<EvidenceRecord[]> {
    return Promise.resolve([...this.records.values()])
  }

  replace(record: EvidenceRecord): void {
    this.records.set(record.evidenceRef.id, record)
  }
}

class Receipts implements TableVerificationReceiptStore {
  readonly receipts = new Map<string, { readonly ref: ResourceRef; readonly receipt: TableVerificationReceipt }>()

  putReceipt(_scopeRef: ScopeRef, receiptRef: ResourceRef, receipt: TableVerificationReceipt): Promise<void> {
    this.receipts.set(receiptRef.id, { ref: receiptRef, receipt })
    return Promise.resolve()
  }

  getReceipt(_scopeRef: ScopeRef, receiptRef: ResourceRef) {
    return Promise.resolve(this.receipts.get(receiptRef.id))
  }
}

class PolicyReports implements TaskPolicyReportStore {
  readonly reports = new Map<string, TaskValidationPolicyReport>()

  putReport(_scopeRef: ScopeRef, reportRef: ResourceRef, report: TaskValidationPolicyReport): Promise<void> {
    this.reports.set(reportRef.id, report)
    return Promise.resolve()
  }

  getReport(_scopeRef: ScopeRef, reportRef: ResourceRef) {
    const report = this.reports.get(reportRef.id)
    return Promise.resolve(report === undefined ? undefined : { ref: reportRef, report })
  }
}

interface Harness {
  readonly artifacts: Artifacts
  readonly evidence: Evidence
}

function harness(): Harness {
  return { artifacts: new Artifacts(), evidence: new Evidence() }
}

function deposit(
  h: Harness,
  input: {
    readonly kind: EvidenceKind
    readonly payload: unknown
    readonly evidenceId?: Uuid
    readonly revision?: string
    readonly envelopeDigestOverride?: string
  },
): EvidenceRecord {
  const evidenceId = input.evidenceId ?? randomUUID()
  const payloadRef = h.artifacts.put(`${evidenceId}-blob`, input.payload)
  const body = {
    evidenceId,
    kind: input.kind,
    scopeRef: SCOPE_A,
    producedBy: { componentRef: { id: 'tool-gateway', version: '1.0.0', digest: sha256DigestOf('gateway') }, runId: RUN_ID },
    observedAt: NOW,
    sourceSnapshots: [{ sourceRef: { namespace: 'ns', sourceId: 'src' }, schemaVersion: '1', readAt: NOW, consistency: 'repeatable_read' as const, resultDigest: payloadRef.digest }],
    resultDigest: payloadRef.digest,
    dependencies: [],
    dataMode: 'observed' as const,
    payloadRef,
  }
  const envelope: EvidenceEnvelope = { ...body, integrity: { algorithm: 'sha256', digest: sha256DigestOf(JSON.stringify(body)), verifiedAt: NOW } }
  const record: EvidenceRecord = {
    evidenceRef: { id: evidenceId, version: '1.0.0', digest: envelope.integrity.digest, kind: 'evidence' },
    envelope,
    envelopeDigest: input.envelopeDigestOverride ?? envelope.integrity.digest,
    revision: input.revision ?? '1',
    recordedAt: NOW,
  }
  h.evidence.replace(record)
  return record
}

function pinOf(record: EvidenceRecord): PublicationDependencyPin {
  return {
    evidenceRef: record.evidenceRef,
    evidenceKind: record.envelope.kind,
    resultDigest: record.envelope.resultDigest,
    envelopeDigest: record.envelopeDigest,
    revision: record.revision,
  }
}

function engine(input: {
  readonly h: Harness
  readonly validators?: readonly PublicationEvidenceValidator[]
  readonly receipts?: Receipts
  readonly policies?: PolicyReports
}): PublicationValidityEngine {
  return new PublicationValidityEngine({
    evidence: input.h.evidence,
    artifacts: input.h.artifacts,
    validators: input.validators ?? defaultPublicationEvidenceValidators(),
    ...(input.receipts === undefined ? {} : { tables: input.receipts }),
    ...(input.policies === undefined ? {} : { policies: input.policies }),
  })
}

const ruleArtifact = (premise: ResourceRef | undefined) => ({
  schemaVersion: 'rule-computation-artifact@1',
  complete: true,
  ruleRef: { id: 'rule.a', version: '1.0.0', digest: sha256DigestOf('rule') },
  ...(premise === undefined ? {} : { premiseRefs: [premise] }),
})

describe('publication validity engine (V03-035 / #206)', () => {
  it('revalidates every evidence kind and their declared support dependencies', async () => {
    const h = harness()
    const premise = deposit(h, { kind: 'observation', payload: { items: [{ kind: 'fact' }] } })
    const observation = deposit(h, { kind: 'observation', payload: { items: [{ kind: 'relation_edge' }] } })
    const span = deposit(h, { kind: 'document_span', payload: { textDigest: `sha256:${'a'.repeat(64)}`, quoteDigest: `sha256:${'b'.repeat(64)}` } })
    const rule = deposit(h, { kind: 'rule_derivation', payload: ruleArtifact(premise.evidenceRef) })
    const compute = deposit(h, { kind: 'computation', payload: { coverage: { returned: 1, truncated: false }, dependencyEvidenceRefs: [observation.evidenceRef] } })
    const identity = deposit(h, { kind: 'identity_decision', payload: { decision: 'merge' } })
    const model = deposit(h, { kind: 'model_output', payload: { text: 'draft' } })
    const web = deposit(h, { kind: 'web_page', payload: { url: 'https://example.test' } })
    const roots = [observation, span, rule, compute, identity, model, web]

    const report = await engine({ h }).check(
      {
        runId: RUN_ID,
        runRevision: '1',
        verificationId: randomUUID(),
        evidenceManifestHash: sha256DigestOf('manifest'),
        evidenceRefs: roots.map(refFor),
        verifiedAt: NOW,
      },
      context(),
    )

    expect(report.publishable).toBe(true)
    expect(report.historyLimited).toBe(false)
    // The transitive support (rule premise + compute input) is re-read and pinned too.
    const ids = new Set((report.dependencies ?? []).map((pin) => pin.evidenceRef.id))
    expect(ids.has(premise.evidenceRef.id)).toBe(true)
    expect(ids.has(observation.evidenceRef.id)).toBe(true)
    expect(ids.size).toBe(roots.length + 1)
  })

  it('blocks when a dependency is no longer visible (retraction / lost permission)', async () => {
    const h = harness()
    const record = deposit(h, { kind: 'observation', payload: { items: [] } })
    h.evidence.records.delete(record.evidenceRef.id)

    const report = await engine({ h }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], verifiedAt: NOW },
      context(),
    )
    expect(report.publishable).toBe(false)
    expect(report.historyLimited).toBe(false)
    expect(report.blockedReasons).toContain('evidence_retracted')
  })

  it('blocks an edited dependency and never downgrades it to history-limited', async () => {
    const h = harness()
    const record = deposit(h, { kind: 'rule_derivation', payload: ruleArtifact(undefined) })
    const pin = pinOf(record)
    // The archived row moves to a new revision after verification.
    h.evidence.replace({ ...record, revision: '9', envelopeDigest: record.envelopeDigest })

    const report = await engine({ h }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], dependencies: [pin], verifiedAt: NOW },
      context(),
    )
    expect(report.publishable).toBe(false)
    expect(report.historyLimited).toBe(false)
    expect(report.blockedReasons).toContain('dependency_edited')
  })

  it('marks an intact-but-stale support as history-limited with an explicit as-of', async () => {
    const h = harness()
    const record = deposit(h, { kind: 'observation', payload: { items: [] } })
    const staleValidator: PublicationEvidenceValidator = {
      evidenceKind: 'observation',
      validate: () => ({ state: 'stale', details: ['the source advanced after verification'] }),
    }

    const report = await engine({ h, validators: [staleValidator] }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], verifiedAt: NOW },
      context(),
    )
    expect(report.publishable).toBe(false)
    expect(report.historyLimited).toBe(true)
    expect(report.asOf).toBe(NOW)
    expect(report.blockedReasons).toEqual(['data_stale'])
  })

  it('blocks when a rule premise is retracted (support walk)', async () => {
    const h = harness()
    const premise = deposit(h, { kind: 'observation', payload: { items: [] } })
    const rule = deposit(h, { kind: 'rule_derivation', payload: ruleArtifact(premise.evidenceRef) })
    h.evidence.records.delete(premise.evidenceRef.id)

    const report = await engine({ h }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [rule.evidenceRef], verifiedAt: NOW },
      context(),
    )
    expect(report.publishable).toBe(false)
    expect(report.blockedReasons).toContain('evidence_retracted')
  })

  it('refuses a dependency whose archived bytes no longer hash to the recorded digest', async () => {
    const h = harness()
    const record = deposit(h, { kind: 'document_span', payload: { textDigest: `sha256:${'a'.repeat(64)}` } })
    h.artifacts.overwrite(`${record.evidenceRef.id}-blob`, '{"tampered":true}')

    const report = await engine({ h }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], verifiedAt: NOW },
      context(),
    )
    expect(report.publishable).toBe(false)
    expect(report.blockedReasons).toContain('evidence_unverifiable')
  })

  it('requires an earned full-table verification receipt before publishing a formal table', async () => {
    const h = harness()
    const receipts = new Receipts()
    const record = deposit(h, { kind: 'observation', payload: { items: [{ kind: 'fact' }] } })
    const resultManifestRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('manifest'), kind: 'artifact' }
    const receiptRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('receipt'), kind: 'artifact' }
    const requirement: PublicationTableVerificationRequirement = {
      draftHash: sha256DigestOf('draft'),
      resultManifestRef,
      resultManifestDigest: resultManifestRef.digest,
      tableId: 'quotation-lines',
      receiptRef,
    }

    const missing = await engine({ h, receipts }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], tableVerifications: [requirement], verifiedAt: NOW },
      context(),
    )
    expect(missing.publishable).toBe(false)
    expect(missing.blockedReasons).toContain('table_verification_missing')

    const receipt: TableVerificationReceipt = {
      schemaVersion: 'table-verification-receipt@1',
      draftHash: requirement.draftHash,
      resultManifestRef,
      resultManifestDigest: resultManifestRef.digest,
      tableId: requirement.tableId,
      pageDigests: [],
      checkedRows: 4,
      expectedRows: 4,
      checkedCells: 8,
      expectedCells: 8,
      checksDigest: sha256DigestOf('checks'),
      policyVersion: 'table-hard-verification@1',
    }
    await receipts.putReceipt(SCOPE_A, receiptRef, receipt)
    const earned = await engine({ h, receipts }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], tableVerifications: [requirement], verifiedAt: NOW },
      context(),
    )
    expect(earned.publishable).toBe(true)

    await receipts.putReceipt(SCOPE_A, receiptRef, { ...receipt, checkedRows: 3 })
    const partial = await engine({ h, receipts }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [record.evidenceRef], tableVerifications: [requirement], verifiedAt: NOW },
      context(),
    )
    expect(partial.publishable).toBe(false)
    expect(partial.blockedReasons).toContain('table_verification_missing')
  })

  it('requires a passing registered policy report and revalidates its dependency evidence', async () => {
    const h = harness()
    const policies = new PolicyReports()
    const reportRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('report'), kind: 'artifact' }
    const policyRef: VersionRef = { id: 'quote-policy', version: '1.0.0', digest: sha256DigestOf('policy') }
    const executionBindingRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('exec'), kind: 'artifact' }
    const inputSnapshotRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('snapshot'), kind: 'artifact' }
    const parametersRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('params'), kind: 'artifact' }
    const requirement: PublicationPolicyReportRequirement = {
      policyRef,
      registryDigest: sha256DigestOf('registry'),
      executionBindingRef,
      inputSnapshotRef,
      inputSnapshotDigest: inputSnapshotRef.digest,
      parametersRef,
      parametersDigest: parametersRef.digest,
      reportRef,
    }
    const report: TaskValidationPolicyReport = {
      schemaVersion: 'task-policy-report@1',
      policyRef,
      registryDigest: requirement.registryDigest,
      reportSchemaRef: { id: 'policy-report', version: '1.0.0', digest: sha256DigestOf('schema') },
      stage: 'result',
      executionBindingRef,
      inputSnapshotRef,
      inputSnapshotDigest: inputSnapshotRef.digest,
      parametersRef,
      parametersDigest: parametersRef.digest,
      status: 'pass',
      coverage: { returned: 1, truncated: false },
      violations: [],
      dependencyEvidenceRefs: [],
    }
    await policies.putReport(SCOPE_A, reportRef, report)

    const passed = await engine({ h, policies }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [], policyReports: [requirement], verifiedAt: NOW },
      context(),
    )
    expect(passed.publishable).toBe(true)

    await policies.putReport(SCOPE_A, reportRef, { ...report, status: 'fail' })
    const failed = await engine({ h, policies }).check(
      { runId: RUN_ID, runRevision: '1', verificationId: randomUUID(), evidenceManifestHash: sha256DigestOf('m'), evidenceRefs: [], policyReports: [requirement], verifiedAt: NOW },
      context(),
    )
    expect(failed.publishable).toBe(false)
    expect(failed.blockedReasons).toContain('policy_report_missing')
  })
})
