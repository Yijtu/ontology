import { isToolContext } from '@ontology/contracts'
import type {
  MappingRef,
  PlanClarification,
  PlanStep,
  ProfileRef,
  ResourceRef,
  RouteSignals,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { canonicalJson } from '@ontology/tool-services'
import type { QueryResultRow } from 'pg'
import type { CoreSemanticTaskSelection } from './core-semantic-task-resolver'
import { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'

const PLAN_RECEIPT_VERSION = '1.0.0'
const MAX_PLAN_RECEIPT_BYTES = 1_048_576
const MAX_PLAN_STEPS = 32
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u

export interface CorePlanReceiptPins {
  readonly runId: Uuid
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly runtimeRef: VersionRef
  readonly inputManifestDigest: Sha256Digest
  readonly effectiveQuestionDigest: Sha256Digest
  readonly mappingRefs: readonly MappingRef[]
  readonly definitionRefs: readonly VersionRef[]
  readonly toolBindingsDigest: Sha256Digest
  readonly routeSignalsDigest: Sha256Digest
  readonly routeClarificationDigest?: Sha256Digest
}

export interface CorePlanRouteSummary {
  readonly route: 'fixed_path' | 'small_plan' | 'clarify'
  readonly reason: string
  readonly signals: RouteSignals
  readonly fallback?: string
}

interface CorePlanReceiptPayloadBase {
  readonly schemaVersion: 'core-template-plan-receipt@1'
  readonly pins: CorePlanReceiptPins
  readonly route: CorePlanRouteSummary
}

export type CorePlanReceiptPayload =
  | (CorePlanReceiptPayloadBase & {
      readonly kind: 'plan'
      readonly steps: readonly PlanStep[]
      readonly taskSelection?: CoreSemanticTaskSelection
    })
  | (CorePlanReceiptPayloadBase & {
      readonly kind: 'clarification'
      readonly clarificationId: Uuid
      readonly clarification: PlanClarification
      readonly clarificationReceiptRef: ResourceRef
    })

export interface CorePlanReceiptRecord {
  readonly ref: ResourceRef
  readonly pins: CorePlanReceiptPins
  readonly payload: CorePlanReceiptPayload
  readonly createdAt: string
}

export interface SaveCorePlanReceiptInput {
  readonly pins: CorePlanReceiptPins
  readonly requestDigest: Sha256Digest
  readonly payload: CorePlanReceiptPayload
  readonly createdAt: string
}

export type CorePlanReceiptErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'PROFILE_MISMATCH'
  | 'RUNTIME_MISMATCH'
  | 'INVALID_REFERENCE'
  | 'CORRUPT_RECORD'
  | 'IDEMPOTENCY_CONFLICT'

export class CorePlanReceiptStoreError extends Error {
  readonly code: CorePlanReceiptErrorCode

  constructor(code: CorePlanReceiptErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CorePlanReceiptStoreError'
    this.code = code
  }
}

interface CorePlanReceiptRow extends QueryResultRow {
  readonly run_id: string
  readonly receipt_id: string
  readonly profile_ref: unknown
  readonly resolved_profile_hash: string
  readonly runtime_ref: unknown
  readonly input_manifest_digest: string
  readonly request_digest: string
  readonly receipt_digest: string
  readonly receipt_payload: unknown
  readonly created_at: Date | string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) &&
    typeof value['id'] === 'string' && value['id'].length > 0 &&
    typeof value['version'] === 'string' && value['version'].length > 0 &&
    typeof value['digest'] === 'string' && DIGEST_PATTERN.test(value['digest'])
}

function isResourceRef(value: unknown): value is ResourceRef {
  return isRecord(value) && isVersionRef(value) && typeof value['kind'] === 'string' && value['kind'].length > 0
}

function isProfileRef(value: unknown): value is ProfileRef {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0 &&
    typeof value['version'] === 'string' && value['version'].length > 0
}

function isMappingRef(value: unknown): value is MappingRef {
  if (!isVersionRef(value) || !isRecord(value)) return false
  const sourceObjectRef = value['sourceObjectRef']
  return (value['role'] === 'telemetry' || value['role'] === 'catalog' || value['role'] === 'documents') &&
    isRecord(sourceObjectRef) &&
    isRecord(sourceObjectRef['sourceRef']) &&
    typeof sourceObjectRef['sourceRef']['namespace'] === 'string' &&
    typeof sourceObjectRef['sourceRef']['sourceId'] === 'string' &&
    typeof sourceObjectRef['objectPath'] === 'string'
}

function isPins(value: unknown): value is CorePlanReceiptPins {
  return isRecord(value) &&
    typeof value['runId'] === 'string' && UUID_PATTERN.test(value['runId']) &&
    isProfileRef(value['profileRef']) &&
    typeof value['resolvedProfileHash'] === 'string' && DIGEST_PATTERN.test(value['resolvedProfileHash']) &&
    isVersionRef(value['runtimeRef']) &&
    typeof value['inputManifestDigest'] === 'string' && DIGEST_PATTERN.test(value['inputManifestDigest']) &&
    typeof value['effectiveQuestionDigest'] === 'string' && DIGEST_PATTERN.test(value['effectiveQuestionDigest']) &&
    Array.isArray(value['mappingRefs']) && value['mappingRefs'].every(isMappingRef) &&
    Array.isArray(value['definitionRefs']) && value['definitionRefs'].every(isVersionRef) &&
    typeof value['toolBindingsDigest'] === 'string' && DIGEST_PATTERN.test(value['toolBindingsDigest']) &&
    typeof value['routeSignalsDigest'] === 'string' && DIGEST_PATTERN.test(value['routeSignalsDigest']) &&
    (value['routeClarificationDigest'] === undefined ||
      (typeof value['routeClarificationDigest'] === 'string' && DIGEST_PATTERN.test(value['routeClarificationDigest'])))
}

function isPlanStep(value: unknown): value is PlanStep {
  return isRecord(value) &&
    typeof value['stepId'] === 'string' && value['stepId'].length > 0 &&
    typeof value['toolId'] === 'string' &&
    typeof value['readOnly'] === 'boolean' &&
    Array.isArray(value['args']) && value['args'].every((argument) =>
      isRecord(argument) && typeof argument['name'] === 'string' && argument['name'].length > 0 &&
      (argument['required'] === undefined || typeof argument['required'] === 'boolean') &&
      (argument['source'] === undefined || isRecord(argument['source'])),
    ) &&
    Array.isArray(value['dependsOn']) && value['dependsOn'].every((id) => typeof id === 'string') &&
    (value['failureBehaviour'] === 'abort' || value['failureBehaviour'] === 'continue')
}

function isClarification(value: unknown): value is PlanClarification {
  return isRecord(value) && isVersionRef(value['questionRef']) &&
    (value['questionType'] === 'choice' || value['questionType'] === 'score' || value['questionType'] === 'noul') &&
    typeof value['prompt'] === 'string' && value['prompt'].length > 0
}

function parsePayload(value: unknown): CorePlanReceiptPayload | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 'core-template-plan-receipt@1' || !isPins(value['pins'])) return undefined
  const route = value['route']
  if (!isRecord(route) ||
      (route['route'] !== 'fixed_path' && route['route'] !== 'small_plan' && route['route'] !== 'clarify') ||
      typeof route['reason'] !== 'string' || route['reason'].length === 0 ||
      (route['fallback'] !== undefined && typeof route['fallback'] !== 'string')) return undefined
  const signals = route['signals']
  if (!isRecord(signals) ||
      (signals['ambiguous'] !== undefined && typeof signals['ambiguous'] !== 'boolean') ||
      (signals['routeAmbiguous'] !== undefined && typeof signals['routeAmbiguous'] !== 'boolean') ||
      (signals['ambiguityReason'] !== undefined && typeof signals['ambiguityReason'] !== 'string')) return undefined
  const routeSummary: CorePlanRouteSummary = {
    route: route['route'],
    reason: route['reason'],
    signals: {
      ...(typeof signals['ambiguous'] === 'boolean' ? { ambiguous: signals['ambiguous'] } : {}),
      ...(typeof signals['routeAmbiguous'] === 'boolean' ? { routeAmbiguous: signals['routeAmbiguous'] } : {}),
      ...(typeof signals['ambiguityReason'] === 'string' ? { ambiguityReason: signals['ambiguityReason'] } : {}),
    },
    ...(typeof route['fallback'] === 'string' ? { fallback: route['fallback'] } : {}),
  }
  if (value['kind'] === 'plan' && routeSummary.route !== 'clarify' &&
      Array.isArray(value['steps']) && value['steps'].length > 0 &&
      value['steps'].length <= MAX_PLAN_STEPS && value['steps'].every(isPlanStep)) {
    const selection = value['taskSelection']
    if (selection !== undefined && (!isRecord(selection) || !isVersionRef(selection['taskBindingRef']) || !isRecord(selection['parameters']))) return undefined
    return {
      schemaVersion: 'core-template-plan-receipt@1',
      kind: 'plan',
      pins: value['pins'],
      route: routeSummary,
      steps: value['steps'],
      ...(isRecord(selection) && isVersionRef(selection['taskBindingRef']) && isRecord(selection['parameters']) ? { taskSelection: { taskBindingRef: selection['taskBindingRef'], parameters: selection['parameters'] } } : {}),
    }
  }
  if (value['kind'] === 'clarification' && routeSummary.route === 'clarify' &&
      typeof value['clarificationId'] === 'string' && UUID_PATTERN.test(value['clarificationId']) &&
      isResourceRef(value['clarificationReceiptRef']) && value['clarificationReceiptRef'].kind === 'artifact' &&
      isClarification(value['clarification'])) {
    return {
      schemaVersion: 'core-template-plan-receipt@1',
      kind: 'clarification',
      pins: value['pins'],
      route: routeSummary,
      clarificationId: value['clarificationId'],
      clarification: value['clarification'],
      clarificationReceiptRef: value['clarificationReceiptRef'],
    }
  }
  return undefined
}

function trustedScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'a host-minted tool context is required')
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId || scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'the plan receipt scope does not match the trusted context')
  }
  return { tenantId, spaceId }
}

function trustedPins(pins: CorePlanReceiptPins, ctx: ToolContext): void {
  if (!isPins(pins)) throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the plan receipt pins are malformed')
  if (pins.runId !== ctx.runId) throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'the plan receipt must belong to the canonical run')
  if (pins.resolvedProfileHash !== ctx.resolvedProfileHash) {
    throw new CorePlanReceiptStoreError('PROFILE_MISMATCH', 'the plan receipt must match the locked profile snapshot')
  }
  if (!ctx.allowedResources.resourceKinds.includes('plan')) {
    throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'the trusted context does not authorize plan resources')
  }
}

function receiptRefOf(row: CorePlanReceiptRow): ResourceRef {
  return { id: row.receipt_id, version: PLAN_RECEIPT_VERSION, digest: row.receipt_digest, kind: 'plan' }
}

function dateText(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function parseRow(row: CorePlanReceiptRow): CorePlanReceiptRecord {
  const payload = parsePayload(row.receipt_payload)
  const pins = payload?.pins
  const ref = receiptRefOf(row)
  if (
    payload === undefined ||
    pins === undefined ||
    pins.runId !== row.run_id ||
    pins.resolvedProfileHash !== row.resolved_profile_hash ||
    !isProfileRef(row.profile_ref) ||
    canonicalJson(pins.profileRef) !== canonicalJson(row.profile_ref) ||
    !isVersionRef(row.runtime_ref) ||
    canonicalJson(pins.runtimeRef) !== canonicalJson(row.runtime_ref) ||
    pins.inputManifestDigest !== row.input_manifest_digest ||
    !DIGEST_PATTERN.test(row.request_digest) ||
    sha256DigestOf(canonicalJson(payload)) !== row.receipt_digest
  ) {
    throw new CorePlanReceiptStoreError('CORRUPT_RECORD', 'the stored plan receipt failed its integrity checks')
  }
  return { ref, pins, payload, createdAt: dateText(row.created_at) }
}

function uuidFromDigest(digest: string): Uuid {
  if (!DIGEST_PATTERN.test(digest)) throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the route request digest is invalid')
  const chars = [...digest.slice('sha256:'.length, 'sha256:'.length + 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** PostgreSQL-backed immutable route/plan receipts for the single selected Template runtime. */
export class PostgresCorePlanReceiptStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  /** Only one immutable executable selection can finalize a question run. */
  async selectedTaskForRun(scopeRef: ScopeRef, ctx: ToolContext): Promise<CoreSemanticTaskSelection | undefined> {
    const scope = trustedScope(scopeRef, ctx)
    const rows = await this.#database.withIdentityScope(scope, async (client) => client.query<CorePlanReceiptRow>(
      `SELECT receipt.run_id, receipt.receipt_id, receipt.profile_ref, receipt.resolved_profile_hash,
              receipt.runtime_ref, receipt.input_manifest_digest, receipt.request_digest,
              receipt.receipt_digest, receipt.receipt_payload, receipt.created_at
         FROM agent_platform.core_plan_receipts receipt JOIN agent_platform.runs run
           ON run.tenant_id=receipt.tenant_id AND run.space_id=receipt.space_id AND run.run_id=receipt.run_id
        WHERE receipt.tenant_id=current_setting('app.tenant_id')::uuid AND receipt.space_id=current_setting('app.space_id')::uuid
          AND receipt.run_id=$1 AND receipt.resolved_profile_hash=$2 AND run.resolved_profile_hash=$2
          AND receipt.receipt_payload->>'kind'='plan' LIMIT 2`, [ctx.runId, ctx.resolvedProfileHash]))
    if (rows.rows.length > 1) throw new CorePlanReceiptStoreError('CORRUPT_RECORD', 'the question run has ambiguous executable receipts')
    const row = rows.rows[0]
    const record = row === undefined ? undefined : parseRow(row)
    return record?.payload.kind === 'plan' ? record.payload.taskSelection : undefined
  }

  async findByRequest(
    scopeRef: ScopeRef,
    pins: CorePlanReceiptPins,
    requestDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<CorePlanReceiptRecord | undefined> {
    const scope = trustedScope(scopeRef, ctx)
    trustedPins(pins, ctx)
    if (!DIGEST_PATTERN.test(requestDigest)) throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the route request digest is invalid')
    return this.#database.withIdentityScope(scope, async (client) => {
      const result = await client.query<CorePlanReceiptRow>(
        `SELECT receipt.run_id, receipt.receipt_id, receipt.profile_ref, receipt.resolved_profile_hash,
                receipt.runtime_ref, receipt.input_manifest_digest, receipt.request_digest,
                receipt.receipt_digest, receipt.receipt_payload, receipt.created_at
           FROM agent_platform.core_plan_receipts AS receipt
           JOIN agent_platform.runs AS run
             ON run.tenant_id = receipt.tenant_id
            AND run.space_id = receipt.space_id
            AND run.run_id = receipt.run_id
          WHERE receipt.tenant_id = current_setting('app.tenant_id')::uuid
            AND receipt.space_id = current_setting('app.space_id')::uuid
            AND receipt.run_id = $1
            AND receipt.request_digest = $2
            AND receipt.profile_ref = $3::jsonb
            AND receipt.resolved_profile_hash = $4
            AND receipt.runtime_ref = $5::jsonb
            AND receipt.input_manifest_digest = $6
            AND run.state = 'collecting'`,
        [pins.runId, requestDigest, JSON.stringify(pins.profileRef), pins.resolvedProfileHash, JSON.stringify(pins.runtimeRef), pins.inputManifestDigest],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : parseRow(row)
    }, { readOnly: true })
  }

  async getByRef(
    scopeRef: ScopeRef,
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<CorePlanReceiptRecord> {
    const scope = trustedScope(scopeRef, ctx)
    if (!ctx.allowedResources.resourceKinds.includes('plan')) {
      throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'the trusted context does not authorize plan resources')
    }
    if (!isResourceRef(ref) || ref.kind !== 'plan' || !UUID_PATTERN.test(ref.id) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(ref.version)) {
      throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the route checkpoint does not contain a valid full plan receipt reference')
    }
    if (ctx.runId.length === 0 || !DIGEST_PATTERN.test(ctx.resolvedProfileHash)) {
      throw new CorePlanReceiptStoreError('SCOPE_MISMATCH', 'the plan receipt requires the canonical run and profile context')
    }
    const row = await this.#database.withIdentityScope(scope, async (client) => {
      const result = await client.query<CorePlanReceiptRow>(
        `SELECT receipt.run_id, receipt.receipt_id, receipt.profile_ref, receipt.resolved_profile_hash,
                receipt.runtime_ref, receipt.input_manifest_digest, receipt.request_digest,
                receipt.receipt_digest, receipt.receipt_payload, receipt.created_at
           FROM agent_platform.core_plan_receipts AS receipt
           JOIN agent_platform.runs AS run
             ON run.tenant_id = receipt.tenant_id
            AND run.space_id = receipt.space_id
            AND run.run_id = receipt.run_id
          WHERE receipt.tenant_id = current_setting('app.tenant_id')::uuid
            AND receipt.space_id = current_setting('app.space_id')::uuid
            AND receipt.run_id = $1
            AND receipt.receipt_id = $2
            AND receipt.resolved_profile_hash = $3
            AND run.resolved_profile_hash = $3
            AND receipt.profile_ref = jsonb_build_object('id', run.profile_id, 'version', run.profile_version)
            AND receipt.runtime_ref = run.runtime_ref
            AND run.state = 'collecting'`,
        [ctx.runId, ref.id, ctx.resolvedProfileHash],
      )
      return result.rows[0]
    }, { readOnly: true })
    if (row === undefined) throw new CorePlanReceiptStoreError('RUN_NOT_FOUND', 'the plan receipt is not visible to this active run')
    const receipt = parseRow(row)
    if (
      receipt.ref.id !== ref.id || receipt.ref.version !== ref.version ||
      receipt.ref.digest !== ref.digest || receipt.ref.kind !== ref.kind
    ) throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the supplied plan receipt does not match its stored full reference')
    return receipt
  }

  async saveIfAbsent(
    scopeRef: ScopeRef,
    input: SaveCorePlanReceiptInput,
    ctx: ToolContext,
  ): Promise<CorePlanReceiptRecord> {
    const scope = trustedScope(scopeRef, ctx)
    trustedPins(input.pins, ctx)
    if (!DIGEST_PATTERN.test(input.requestDigest) || parsePayload(input.payload) === undefined ||
        input.payload.pins.runId !== input.pins.runId ||
        canonicalJson(input.payload.pins) !== canonicalJson(input.pins) ||
        !Number.isFinite(Date.parse(input.createdAt))) {
      throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the new plan receipt has invalid or inconsistent pins')
    }
    const payloadJson = canonicalJson(input.payload)
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_PLAN_RECEIPT_BYTES ||
        (input.payload.kind === 'plan' && input.payload.steps.length > MAX_PLAN_STEPS)) {
      throw new CorePlanReceiptStoreError('INVALID_REFERENCE', 'the immutable plan receipt exceeds its bounded size')
    }
    const receiptDigest = sha256DigestOf(payloadJson)
    const receiptId = uuidFromDigest(input.requestDigest)
    const saved = await this.#database.withIdentityScope(scope, async (client) => {
      const run = await client.query<{ readonly resolved_profile_hash: string; readonly profile_id: string; readonly profile_version: string; readonly runtime_ref: VersionRef; readonly state: string } & QueryResultRow>(
        `SELECT resolved_profile_hash, profile_id, profile_version, runtime_ref, state
           FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
          FOR UPDATE`,
        [input.pins.runId],
      )
      const runRow = run.rows[0]
      if (runRow === undefined || runRow.state !== 'collecting') {
        throw new CorePlanReceiptStoreError('RUN_NOT_FOUND', 'route preparation requires an active collecting run')
      }
      if (
        runRow.resolved_profile_hash !== input.pins.resolvedProfileHash ||
        runRow.profile_id !== input.pins.profileRef.id ||
        runRow.profile_version !== input.pins.profileRef.version
      ) throw new CorePlanReceiptStoreError('PROFILE_MISMATCH', 'the receipt profile differs from the immutable run binding')
      if (canonicalJson(runRow.runtime_ref) !== canonicalJson(input.pins.runtimeRef)) {
        throw new CorePlanReceiptStoreError('RUNTIME_MISMATCH', 'the receipt runtime differs from the immutable run binding')
      }
      const inserted = await client.query<CorePlanReceiptRow>(
        `INSERT INTO agent_platform.core_plan_receipts
           (tenant_id, space_id, run_id, receipt_id, profile_ref, resolved_profile_hash, runtime_ref,
            input_manifest_digest, request_digest, receipt_digest, receipt_payload, created_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz)
         ON CONFLICT (tenant_id, space_id, run_id, request_digest) DO NOTHING
         RETURNING run_id, receipt_id, profile_ref, resolved_profile_hash, runtime_ref,
                   input_manifest_digest, request_digest, receipt_digest, receipt_payload, created_at`,
        [
          input.pins.runId,
          receiptId,
          JSON.stringify(input.pins.profileRef),
          input.pins.resolvedProfileHash,
          JSON.stringify(input.pins.runtimeRef),
          input.pins.inputManifestDigest,
          input.requestDigest,
          receiptDigest,
          payloadJson,
          input.createdAt,
        ],
      )
      const created = inserted.rows[0]
      if (created !== undefined) return created
      const existing = await client.query<CorePlanReceiptRow>(
        `SELECT run_id, receipt_id, profile_ref, resolved_profile_hash, runtime_ref,
                input_manifest_digest, request_digest, receipt_digest, receipt_payload, created_at
           FROM agent_platform.core_plan_receipts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND request_digest = $2`,
        [input.pins.runId, input.requestDigest],
      )
      const row = existing.rows[0]
      if (row === undefined) throw new CorePlanReceiptStoreError('CORRUPT_RECORD', 'the idempotent receipt insert could not be recovered')
      if (
        row.receipt_digest !== receiptDigest ||
        row.resolved_profile_hash !== input.pins.resolvedProfileHash ||
        row.input_manifest_digest !== input.pins.inputManifestDigest ||
        canonicalJson(row.profile_ref) !== canonicalJson(input.pins.profileRef) ||
        canonicalJson(row.runtime_ref) !== canonicalJson(input.pins.runtimeRef)
      ) throw new CorePlanReceiptStoreError('IDEMPOTENCY_CONFLICT', 'the same route request produced a different immutable plan receipt')
      return row
    })
    return parseRow(saved)
  }
}
