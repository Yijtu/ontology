import { isToolContext, isResourceRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStorePort,
  PublicationBlockReason,
  PublicationDependencyPin,
  PublicationPolicyReportRequirement,
  PublicationTableVerificationRequirement,
  PublicationValidityReport,
  PublicationValidityRequest,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  TableVerificationReceiptStore,
  TaskPolicyReportStore,
  ToolContext,
  VersionRef,
  RulePremiseReplayPort,
} from '@ontology/contracts'
import type { VerificationArtifactStore } from './service'

/**
 * Per-evidence-kind publication validity (SPEC v0.3a execution-evidence §EX-7.2).
 *
 * The publication gate must re-check the dependencies of *every* evidence kind the verified
 * draft rests on — an observation (published fact / table / relation), a document span, a rule
 * derivation, a computation, an identity decision, a model output or a web page — not just the
 * shape of a fact page. Each dependency is re-read, its exact archived bytes are re-hashed and
 * its revision/digest pin is re-checked, so a later edit or a retraction blocks publication
 * instead of silently publishing stale support. A dependency that merely advanced (stale, but
 * the archived support is intact) may still be published **explicitly marked** as
 * history-limited with an `asOf`; a retracted/edited/unverifiable one never may.
 */

/** The archived evidence one kind-specific validator sees. `payload` is untrusted JSON. */
export interface PublicationEvidenceValidationInput {
  readonly record: EvidenceRecord
  readonly payload: unknown
  readonly now: Rfc3339UtcTimestamp
  /** The host-minted trusted context, so a validator can re-read its own source of truth. */
  readonly ctx: ToolContext
}

/**
 * The kind-specific verdict. `stale` means the support still exists but the world moved on
 * (history-limited is allowed); `blocked` means the support can no longer justify a new
 * publication. `supportRefs` are extra evidence refs this artifact depends on (e.g. rule
 * premises, compute inputs) and are revalidated by the engine under the same rules.
 */
export interface PublicationEvidenceValidation {
  readonly state: 'current' | 'stale' | 'blocked'
  readonly reasons?: readonly PublicationBlockReason[]
  readonly details?: readonly string[]
  readonly supportRefs?: readonly ResourceRef[]
}

/** A validator bound to exactly one `EvidenceKind`; the registry is keyed by that kind. */
export interface PublicationEvidenceValidator {
  readonly evidenceKind: EvidenceKind
  validate(input: PublicationEvidenceValidationInput): PublicationEvidenceValidation | Promise<PublicationEvidenceValidation>
}

export interface PublicationValidityEngineDependencies {
  readonly evidence: EvidenceStorePort
  readonly artifacts: VerificationArtifactStore
  /** Kind-specific validators; a missing kind falls back to the generic current-artifact check. */
  readonly validators: readonly PublicationEvidenceValidator[]
  /** Verified table receipts; a formal table without one can never publish. */
  readonly tables?: TableVerificationReceiptStore
  /** Registered validation-policy reports the result depends on. */
  readonly policies?: TaskPolicyReportStore
  readonly now?: () => Rfc3339UtcTimestamp
  /** Bound on the support dependency walk so a cyclic/fan-out graph cannot loop. */
  readonly maxDependencyDepth?: number
}

interface ResolvedEvidence {
  readonly record: EvidenceRecord
  readonly payload?: unknown
  readonly unreadable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameResourceRef(left: unknown, right: ResourceRef): boolean {
  if (!isRecord(left)) return false
  return (
    left['id'] === right.id &&
    left['version'] === right.version &&
    left['digest'] === right.digest &&
    left['kind'] === right.kind
  )
}

function sameVersionRef(left: unknown, right: VersionRef): boolean {
  if (!isRecord(left)) return false
  return left['id'] === right.id && left['version'] === right.version && left['digest'] === right.digest
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new Error('a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new Error('the trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/** Collect `ResourceRef`s from a payload array field, keeping only evidence refs. */
function evidenceRefsIn(payload: unknown, field: string): ResourceRef[] {
  if (!isRecord(payload)) return []
  const value = payload[field]
  if (!Array.isArray(value)) return []
  const refs: ResourceRef[] = []
  for (const entry of value) {
    if (isRecord(entry) && entry['kind'] === 'evidence' && typeof entry['id'] === 'string' && typeof entry['version'] === 'string' && isSha256(entry['digest'])) {
      refs.push({ id: entry['id'], version: entry['version'], digest: entry['digest'], kind: 'evidence' })
    }
  }
  return refs
}

/** The generic fallback: the archived artifact is readable and hash-consistent (checked upstream). */
const CURRENT: PublicationEvidenceValidation = { state: 'current' }

/**
 * Document-span validity is partly intrinsic: the exact archived quote/text digests must be
 * well formed. A span whose declared digests are malformed is unverifiable, not current.
 */
export function documentSpanValidator(): PublicationEvidenceValidator {
  return {
    evidenceKind: 'document_span',
    validate({ payload }) {
      if (!isRecord(payload)) return CURRENT
      const textDigest = payload['textDigest']
      const quoteDigest = payload['quoteDigest']
      if ((textDigest !== undefined && !isSha256(textDigest)) || (quoteDigest !== undefined && !isSha256(quoteDigest))) {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['a document span declares a malformed quote/text digest'] }
      }
      return CURRENT
    },
  }
}

/**
 * Rule-derivation validity: an incomplete computation cannot justify a new conclusion, and the
 * premise evidence the computation rested on is revalidated by the engine. A model boolean is
 * never consulted here.
 */
export function ruleDerivationValidator(replay?: RulePremiseReplayPort): PublicationEvidenceValidator {
  return {
    evidenceKind: 'rule_derivation',
    async validate({ payload, ctx }) {
      if (!isRecord(payload)) return replay === undefined ? CURRENT : { state: 'blocked', reasons: ['evidence_unverifiable'] }
      const inner = payload['artifact']
      const artifact: Record<string, unknown> = isRecord(inner) ? inner : payload
      if (replay !== undefined) {
        let verified = false
        try { verified = await replay.verify({ artifact, payload }, ctx) } catch { /* Missing sources and current withdrawals block publication. */ }
        if (!verified) return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['actual archived rule premises no longer pass independent verification'] }
      }
      if (artifact['complete'] === false) {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['the rule computation is marked incomplete'] }
      }
      const supportRefs = [
        ...evidenceRefsIn(artifact, 'premiseRefs'),
        ...evidenceRefsIn(artifact, 'dependencyEvidenceRefs'),
        ...evidenceRefsIn(payload, 'premiseRefs'),
        ...evidenceRefsIn(payload, 'dependencyEvidenceRefs'),
      ]
      return supportRefs.length === 0 ? CURRENT : { state: 'current', supportRefs }
    },
  }
}

/**
 * Compute validity: the invocation's declared input dependencies are revalidated; a truncated
 * coverage is not a complete result and cannot publish.
 */
export function computationValidator(): PublicationEvidenceValidator {
  return {
    evidenceKind: 'computation',
    validate({ payload }) {
      if (!isRecord(payload)) return CURRENT
      const coverage = payload['coverage']
      if (isRecord(coverage) && coverage['truncated'] === true) {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['the computation output is truncated and not a complete result'] }
      }
      const supportRefs = evidenceRefsIn(payload, 'dependencyEvidenceRefs')
      return supportRefs.length === 0 ? CURRENT : { state: 'current', supportRefs }
    },
  }
}

/** Web pages follow the same generic current-artifact rule; freshness is an as-of concern. */
export function webPageValidator(): PublicationEvidenceValidator {
  return { evidenceKind: 'web_page', validate: () => CURRENT }
}

/** Identity decisions and model outputs are dependencies; they carry no independent business value. */
export function passThroughValidator(evidenceKind: EvidenceKind): PublicationEvidenceValidator {
  return { evidenceKind, validate: () => CURRENT }
}

/** The generic observation check: revalidate any declared input dependencies. */
export function observationValidator(): PublicationEvidenceValidator {
  return {
    evidenceKind: 'observation',
    validate({ payload }) {
      const supportRefs = evidenceRefsIn(payload, 'dependencyEvidenceRefs')
      return supportRefs.length === 0 ? CURRENT : { state: 'current', supportRefs }
    },
  }
}

/** The default registry; a composition may override any kind (notably `observation`). */
export function defaultPublicationEvidenceValidators(): readonly PublicationEvidenceValidator[] {
  return [
    observationValidator(),
    documentSpanValidator(),
    ruleDerivationValidator(),
    computationValidator(),
    webPageValidator(),
    passThroughValidator('identity_decision'),
    passThroughValidator('model_output'),
  ]
}

/**
 * The generic publication-validity engine. It is deterministic over the injected stores and
 * validators: no model score, client flag or SDK event reaches this decision.
 */
export class PublicationValidityEngine {
  readonly #evidence: EvidenceStorePort
  readonly #artifacts: VerificationArtifactStore
  readonly #validators: ReadonlyMap<EvidenceKind, PublicationEvidenceValidator>
  readonly #tables: TableVerificationReceiptStore | undefined
  readonly #policies: TaskPolicyReportStore | undefined
  readonly #now: () => Rfc3339UtcTimestamp
  readonly #maxDependencyDepth: number

  constructor(dependencies: PublicationValidityEngineDependencies) {
    this.#evidence = dependencies.evidence
    this.#artifacts = dependencies.artifacts
    this.#validators = new Map(dependencies.validators.map((validator) => [validator.evidenceKind, validator]))
    this.#tables = dependencies.tables
    this.#policies = dependencies.policies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#maxDependencyDepth = dependencies.maxDependencyDepth ?? 64
  }

  async check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    const scopeRef = scopeOf(ctx)
    const now = this.#now()

    const expectedByRef = new Map<string, PublicationDependencyPin>()
    for (const pin of request.dependencies ?? []) expectedByRef.set(pin.evidenceRef.id, pin)

    const rootRefs = new Map<string, ResourceRef>()
    for (const ref of request.evidenceRefs) rootRefs.set(ref.id, ref)
    for (const pin of request.dependencies ?? []) rootRefs.set(pin.evidenceRef.id, pin.evidenceRef)
    const hasNamedRequirements = (request.tableVerifications?.length ?? 0) > 0 || (request.policyReports?.length ?? 0) > 0
    if (rootRefs.size === 0 && !hasNamedRequirements) {
      return { publishable: false, blockedReasons: ['evidence_retracted'], historyLimited: false, details: ['the verified draft names no evidence dependency'] }
    }

    const visited = new Set<string>()
    const collected: PublicationDependencyPin[] = []
    const blockedReasons: PublicationBlockReason[] = []
    const details: string[] = []

    for (const ref of rootRefs.values()) {
      await this.#validateRef(ref, expectedByRef.get(ref.id), 0, visited, collected, blockedReasons, details, scopeRef, now, ctx)
    }
    await this.#checkTables(request.tableVerifications, scopeRef, blockedReasons, details, ctx)
    await this.#checkPolicies(request.policyReports, 0, visited, collected, blockedReasons, details, scopeRef, now, ctx)

    const unique = [...new Set(blockedReasons)]
    const historyLimited = unique.length > 0 && unique.every((reason) => reason === 'data_stale')
    return {
      publishable: unique.length === 0,
      blockedReasons: unique,
      historyLimited,
      ...(historyLimited ? { asOf: request.verifiedAt } : {}),
      details,
      dependencies: collected,
    }
  }

  async #checkTables(
    requirements: readonly PublicationTableVerificationRequirement[] | undefined,
    scopeRef: ScopeRef,
    blockedReasons: PublicationBlockReason[],
    details: string[],
    ctx: ToolContext,
  ): Promise<void> {
    if (requirements === undefined || requirements.length === 0) return
    if (this.#tables === undefined) {
      blockedReasons.push('table_verification_missing')
      details.push('the result declares formal tables but no receipt store is configured to prove them')
      return
    }
    for (const requirement of requirements) {
      const archived = await this.#tables.getReceipt(scopeRef, requirement.receiptRef, ctx)
      if (archived === undefined) {
        blockedReasons.push('table_verification_missing')
        details.push(`table ${requirement.tableId} has no archived full-table verification receipt`)
        continue
      }
      const receipt = archived.receipt
      const earned =
        receipt.draftHash === requirement.draftHash &&
        receipt.resultManifestDigest === requirement.resultManifestDigest &&
        receipt.tableId === requirement.tableId &&
        sameResourceRef(receipt.resultManifestRef, requirement.resultManifestRef) &&
        receipt.checkedRows === receipt.expectedRows &&
        receipt.checkedCells === receipt.expectedCells
      if (!earned) {
        blockedReasons.push('table_verification_missing')
        details.push(`table ${requirement.tableId} receipt does not prove the complete verified table`)
      }
    }
  }

  /**
   * Re-read every required registered policy report and prove it is the same policy/registry/
   * execution revision it was verified against and that it passed. The report's declared
   * dependency evidence is then revalidated like any other support.
   */
  async #checkPolicies(
    requirements: readonly PublicationPolicyReportRequirement[] | undefined,
    depth: number,
    visited: Set<string>,
    collected: PublicationDependencyPin[],
    blockedReasons: PublicationBlockReason[],
    details: string[],
    scopeRef: ScopeRef,
    now: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<void> {
    if (requirements === undefined || requirements.length === 0) return
    if (this.#policies === undefined) {
      blockedReasons.push('policy_report_missing')
      details.push('the result requires registered policy reports but no report store is configured')
      return
    }
    for (const requirement of requirements) {
      const archived = await this.#policies.getReport(scopeRef, requirement.reportRef, ctx)
      const report = archived?.report
      if (
        archived === undefined ||
        report === undefined ||
        report.status !== 'pass' ||
        report.registryDigest !== requirement.registryDigest ||
        !sameVersionRef(report.policyRef, requirement.policyRef) ||
        !sameResourceRef(report.executionBindingRef, requirement.executionBindingRef) ||
        !sameResourceRef(report.inputSnapshotRef, requirement.inputSnapshotRef) ||
        report.inputSnapshotDigest !== requirement.inputSnapshotDigest ||
        !sameResourceRef(report.parametersRef, requirement.parametersRef) ||
        report.parametersDigest !== requirement.parametersDigest
      ) {
        blockedReasons.push('policy_report_missing')
        details.push(`registered policy report for ${requirement.policyRef.id} is missing, failed, or bound to another revision`)
        continue
      }
      for (const dependency of report.dependencyEvidenceRefs) {
        if (dependency.kind !== 'evidence' || dependency.id === requirement.reportRef.id) continue
        await this.#validateRef(dependency, undefined, depth + 1, visited, collected, blockedReasons, details, scopeRef, now, ctx)
      }
    }
  }

  async #validateRef(
    ref: ResourceRef,
    expected: PublicationDependencyPin | undefined,
    depth: number,
    visited: Set<string>,
    collected: PublicationDependencyPin[],
    blockedReasons: PublicationBlockReason[],
    details: string[],
    scopeRef: ScopeRef,
    now: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<void> {
    if (visited.has(ref.id)) return
    visited.add(ref.id)

    if (depth > this.#maxDependencyDepth) {
      blockedReasons.push('evidence_unverifiable')
      details.push(`evidence ${ref.id} exceeds the ${String(this.#maxDependencyDepth)}-hop dependency bound`)
      return
    }

    const record = await this.#evidence.get(scopeRef, ref.id, ctx)
    if (record === undefined || !sameResourceRef(record.evidenceRef, ref)) {
      blockedReasons.push('evidence_retracted')
      details.push(`evidence ${ref.id} is no longer visible in this scope`)
      return
    }
    if (record.envelope.integrity.digest !== record.envelopeDigest) {
      blockedReasons.push('evidence_unverifiable')
      details.push(`evidence ${ref.id} integrity proof does not match the archived envelope digest`)
      return
    }
    if (
      expected !== undefined &&
      (record.revision !== expected.revision ||
        record.envelope.resultDigest !== expected.resultDigest ||
        record.envelopeDigest !== expected.envelopeDigest ||
        record.envelope.kind !== expected.evidenceKind)
    ) {
      blockedReasons.push('dependency_edited')
      details.push(`evidence ${ref.id} changed after the draft was verified (revision ${record.revision} vs ${expected.revision})`)
      return
    }

    const resolved = await this.#readEvidence(scopeRef, record, ctx)
    if (resolved.unreadable || resolved.payload === undefined) {
      blockedReasons.push('evidence_unverifiable')
      details.push(`evidence ${ref.id} could not be re-read from its archived payload`)
      return
    }

    collected.push({
      evidenceRef: record.evidenceRef,
      evidenceKind: record.envelope.kind,
      resultDigest: record.envelope.resultDigest,
      envelopeDigest: record.envelopeDigest,
      revision: record.revision,
    })

    const validator = this.#validators.get(record.envelope.kind)
    const outcome: PublicationEvidenceValidation =
      validator === undefined ? CURRENT : await validator.validate({ record, payload: resolved.payload, now, ctx })

    if (outcome.state === 'stale') {
      blockedReasons.push('data_stale')
      details.push(`evidence ${ref.id} is stale but its archived support is intact`, ...(outcome.details ?? []))
    } else if (outcome.state === 'blocked') {
      blockedReasons.push(...(outcome.reasons ?? ['evidence_unverifiable']))
      details.push(...(outcome.details ?? [`evidence ${ref.id} is not valid for a new publication`]))
    }

    for (const support of outcome.supportRefs ?? []) {
      if (support.kind !== 'evidence' || support.id === ref.id) continue
      await this.#validateRef(support, undefined, depth + 1, visited, collected, blockedReasons, details, scopeRef, now, ctx)
    }
  }

  async #readEvidence(scopeRef: ScopeRef, record: EvidenceRecord, ctx: ToolContext): Promise<ResolvedEvidence> {
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) return { record, unreadable: true }
    try {
      const authorized = await this.#artifacts.getAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      if (!authorized.integrityVerified) return { record, unreadable: true }
      const bytes = await this.#artifacts.readAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const payload: unknown = JSON.parse(text)
      if (sha256DigestOf(text) !== record.envelope.resultDigest) {
        // A rule span archives its immutable locator binding separately from the exact source
        // bytes. Validate both digests rather than treating the binding JSON as the quoted text.
        if (record.envelope.kind !== 'document_span' || sha256DigestOf(text) !== payloadRef.digest || !isRecord(payload) ||
          !['rule-source-span-binding@1', 'rule-policy-span-binding@1'].includes(String(payload['schemaVersion'])) || !isResourceRef(payload['textArtifactRef'])) return { record, unreadable: true }
        const sourceRef = payload['textArtifactRef']
        const sourceMetadata = await this.#artifacts.getAuthorized({ scopeRef, blobRef: sourceRef }, ctx)
        if (!sourceMetadata.integrityVerified) return { record, unreadable: true }
        const sourceBytes = await this.#artifacts.readAuthorized({ scopeRef, blobRef: sourceRef }, ctx)
        const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
        if (sourceBytes.byteLength > 128 * 1024 || sha256DigestOf(sourceText) !== sourceRef.digest || sourceRef.digest !== record.envelope.resultDigest) return { record, unreadable: true }
      }
      return { record, payload, unreadable: false }
    } catch {
      return { record, unreadable: true }
    }
  }
}
