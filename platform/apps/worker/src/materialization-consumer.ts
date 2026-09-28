import { isToolContext } from '@ontology/contracts'
import type {
  ControlRepository,
  MaterializationChange,
  MaterializationStore,
  NewOutboxMessage,
  OutboxMessageRecord,
  PublishedStatement,
  PublishedRuleVersion,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  SemanticPublicationVersion,
  ToolContext,
  Uuid,
  ValidityInterval,
} from '@ontology/contracts'
import type { OutboxConsumer } from '@ontology/application'
import { sha256DigestOf } from '@ontology/semantic-engine'
import type { IncrementalMaterializer, MaterializationTicket, PublishedSemanticReadView } from '@ontology/semantic-engine'

/** The outbox topic a publication handler hands the worker to advance asynchronously. */
export const MATERIALIZATION_REQUESTED_TOPIC = 'semantic.materialization.requested'
/** The publication transaction's outbox event (LOCAL-031). */
export const PUBLICATION_PUBLISHED_TOPIC = 'semantic.publication.published'
/** A statement correction or retraction (LOCAL-031). */
export const STATEMENT_CORRECTED_TOPIC = 'semantic.statement.corrected'
export const STATEMENT_RETRACTED_TOPIC = 'semantic.statement.retracted'
/** The identity decision outbox event emitted atomically with a candidate split. */
export const IDENTITY_SPLIT_TOPIC = 'identity.decision.split'

const REQUEST_TOPIC = MATERIALIZATION_REQUESTED_TOPIC
const DEFAULT_PAGE_SIZE = 1_000
const MAX_PUBLICATION_SCAN = 100_000

export type MaterializationOutboxErrorCode =
  | 'INVALID_MESSAGE'
  | 'PUBLICATION_NOT_VISIBLE'
  | 'STATEMENT_NOT_VISIBLE'
  | 'PUBLICATION_SCAN_LIMIT'

/** A malformed or unresolvable materialisation outbox message. Never swallowed into a no-op. */
export class MaterializationOutboxError extends Error {
  readonly code: MaterializationOutboxErrorCode

  constructor(code: MaterializationOutboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MaterializationOutboxError'
    this.code = code
  }
}

/**
 * The published read view the materialisation consumer needs to turn a publication event into a
 * change. `PostgresSemanticPublicationStore` (LOCAL-031) satisfies it structurally, so the
 * consumer never imports an adapter.
 */
export interface MaterializationPublicationView extends PublishedSemanticReadView {
  getPublication(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion | undefined>
  getStatement(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<PublishedStatement | undefined>
}

/**
 * Allocate the platform record sequence (`semantic_events` per-space seq) that a change records
 * as its watermark. It is idempotent on `idempotencyKey`, so re-delivering the same outbox
 * message yields the same sequence instead of advancing the watermark twice.
 */
export interface MaterializationRecordSequence {
  next(scopeRef: ScopeRef, idempotencyKey: string, ctx: ToolContext): Promise<RevisionString>
}

/** The transactional-outbox writer a consumer uses to hand the change back to the worker. */
export interface MaterializationOutboxWriter {
  appendOutbox(
    scopeRef: ScopeRef,
    jobId: Uuid,
    message: NewOutboxMessage,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord>
}

export interface MaterializationOutboxConsumerDependencies {
  readonly materializer: IncrementalMaterializer
  readonly publications: MaterializationPublicationView
  readonly sequence: MaterializationRecordSequence
  readonly outbox: MaterializationOutboxWriter
  /** The same store the materialiser writes fences to, used to release a fence if enqueue fails. */
  readonly materialization: MaterializationStore
  readonly pageSize?: number
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new MaterializationOutboxError(
      'INVALID_MESSAGE',
      'trusted context carries inconsistent tenant scope',
    )
  }
  return { tenantId, spaceId }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', `the outbox payload field "${key}" is required`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseScopeRef(value: unknown): ScopeRef {
  const record = asRecord(value)
  if (record === undefined) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'the change scopeRef must be a JSON object')
  }
  return {
    tenantId: requiredString(record, 'tenantId'),
    spaceId: requiredString(record, 'spaceId'),
  }
}

function parseValidity(value: unknown): ValidityInterval {
  const record = asRecord(value)
  if (record === undefined) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'the change validity must be a JSON object')
  }
  const validTo = optionalString(record['validTo'])
  return {
    validFrom: requiredString(record, 'validFrom'),
    ...(validTo === undefined ? {} : { validTo }),
  }
}

/** Serialize a `MaterializationChange` into the JSONB outbox payload. */
export function serializeMaterializationChange(
  change: MaterializationChange,
): Record<string, unknown> {
  const base = {
    changeId: change.changeId,
    scopeRef: change.scopeRef,
    recordedSeq: change.recordedSeq,
    recordedAt: change.recordedAt,
    kind: change.kind,
  }
  switch (change.kind) {
    case 'assertion_published':
    case 'assertion_corrected':
    case 'assertion_retracted':
      return {
        ...base,
        logicalAssertionId: change.logicalAssertionId,
        predicate: change.predicate,
        ...(change.subjectEntityId === undefined ? {} : { subjectEntityId: change.subjectEntityId }),
        validity: change.validity,
      }
    case 'rule_changed':
      return { ...base, ruleId: change.ruleId, propositionKey: change.propositionKey }
    case 'identity_changed':
      return {
        ...base,
        entityId: change.entityId,
        ...(change.objectId === undefined ? {} : { objectId: change.objectId }),
        separatedCandidateIds: change.separatedCandidateIds,
        reason: change.reason,
      }
    case 'validity_expired':
      return {
        ...base,
        logicalAssertionId: change.logicalAssertionId,
        predicate: change.predicate,
        validAt: change.validAt,
      }
  }
}

/** Validate and decode a `MaterializationChange` from an untrusted outbox payload. */
export function parseMaterializationChange(value: unknown): MaterializationChange {
  const record = asRecord(value)
  if (record === undefined) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'the change must be a JSON object')
  }
  const changeId = requiredString(record, 'changeId')
  const recordedSeq = requiredString(record, 'recordedSeq')
  const recordedAt = requiredString(record, 'recordedAt')
  const kind = requiredString(record, 'kind')
  const scopeRef = parseScopeRef(record['scopeRef'])
  const base = { changeId, scopeRef, recordedSeq, recordedAt }
  switch (kind) {
    case 'assertion_published':
    case 'assertion_corrected':
    case 'assertion_retracted': {
      const subjectEntityId = optionalString(record['subjectEntityId'])
      return {
        ...base,
        kind,
        logicalAssertionId: requiredString(record, 'logicalAssertionId'),
        predicate: requiredString(record, 'predicate'),
        ...(subjectEntityId === undefined ? {} : { subjectEntityId }),
        validity: parseValidity(record['validity']),
      }
    }
    case 'rule_changed':
      return {
        ...base,
        kind,
        ruleId: requiredString(record, 'ruleId'),
        propositionKey: requiredString(record, 'propositionKey'),
      }
    case 'identity_changed': {
      const objectId = optionalString(record['objectId'])
      return {
        ...base,
        kind,
        entityId: requiredString(record, 'entityId'),
        ...(objectId === undefined ? {} : { objectId }),
        separatedCandidateIds: parseUuidArray(record['separatedCandidateIds']),
        reason: requiredString(record, 'reason'),
      }
    }
    case 'validity_expired':
      return {
        ...base,
        kind,
        logicalAssertionId: requiredString(record, 'logicalAssertionId'),
        predicate: requiredString(record, 'predicate'),
        validAt: requiredString(record, 'validAt'),
      }
    default:
      throw new MaterializationOutboxError('INVALID_MESSAGE', `unknown materialization change kind "${kind}"`)
  }
}

/**
 * Read the `changeId → fenceId` bindings the publication/revision transaction wrote into the
 * outbox payload. When present, the fence was already opened atomically with the state change, so
 * the consumer must reuse it instead of opening a second one after the commit (LOCAL-070). An
 * absent field is the pre-LOCAL-070 shape, for which the consumer falls back to opening the fence
 * itself.
 */
function parseFenceBindings(payload: Readonly<Record<string, unknown>>): ReadonlyMap<Uuid, Uuid> {
  const raw = payload['materializationFences']
  if (raw === undefined) return new Map()
  if (!Array.isArray(raw)) {
    throw new MaterializationOutboxError(
      'INVALID_MESSAGE',
      'the materializationFences field must be an array',
    )
  }
  const bindings = new Map<Uuid, Uuid>()
  for (const entry of raw) {
    const record = asRecord(entry)
    if (record === undefined) {
      throw new MaterializationOutboxError(
        'INVALID_MESSAGE',
        'each materializationFence binding must be a JSON object',
      )
    }
    bindings.set(requiredString(record, 'changeId'), requiredString(record, 'fenceId'))
  }
  return bindings
}

function parseUuidArray(value: unknown): readonly Uuid[] {
  if (!Array.isArray(value)) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'separatedCandidateIds must be an array')
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new MaterializationOutboxError('INVALID_MESSAGE', 'separatedCandidateIds must be uuids')
    }
    return entry
  })
}

function validityOf(statement: PublishedStatement): ValidityInterval {
  return {
    validFrom: statement.validFrom ?? statement.recordedAt,
    ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }),
  }
}

function compareRulePosition(
  left: Pick<PublishedRuleVersion, 'ruleId' | 'version'>,
  right: Pick<PublishedRuleVersion, 'ruleId' | 'version'>,
): number {
  if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1
  let leftVersion: bigint
  let rightVersion: bigint
  try {
    if (!/^(?:0|[1-9]\d*)$/.test(left.version) || !/^(?:0|[1-9]\d*)$/.test(right.version)) throw new Error('noncanonical revision')
    leftVersion = BigInt(left.version)
    rightVersion = BigInt(right.version)
  } catch (error) {
    throw new MaterializationOutboxError('INVALID_MESSAGE', 'published rule revisions must be canonical non-negative integers', { cause: error })
  }
  return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0
}

/**
 * The semantic-materialisation outbox consumer (LOCAL-069, SPEC D5/D5.1/D6, ADR-13).
 *
 * It is the missing production wiring for LOCAL-033. On a publication event it opens the
 * invalidation fence through `IncrementalMaterializer.beginChange` and enqueues a
 * `semantic.materialization.requested` message in the same step, so the worker advances the
 * projection asynchronously; a read that meets the open fence returns `fenced` instead of a
 * stale conclusion. On a materialisation request it calls `advance`, which is idempotent on the
 * change's `recordedSeq`, so an at-least-once re-delivery after a crash reclaim cannot advance
 * the same change twice.
 *
 * The consumer is additive: it registers new topics and never changes the publication or
 * materialisation contract. It does not recompute rules itself and does not touch a driver.
 */
export class MaterializationOutboxConsumer implements OutboxConsumer {
  readonly topics: readonly string[] = [
    REQUEST_TOPIC,
    PUBLICATION_PUBLISHED_TOPIC,
    STATEMENT_CORRECTED_TOPIC,
    STATEMENT_RETRACTED_TOPIC,
    IDENTITY_SPLIT_TOPIC,
  ]

  readonly #materializer: IncrementalMaterializer
  readonly #publications: MaterializationPublicationView
  readonly #sequence: MaterializationRecordSequence
  readonly #outbox: MaterializationOutboxWriter
  readonly #materialization: MaterializationStore
  readonly #pageSize: number
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: MaterializationOutboxConsumerDependencies) {
    this.#materializer = dependencies.materializer
    this.#publications = dependencies.publications
    this.#sequence = dependencies.sequence
    this.#outbox = dependencies.outbox
    this.#materialization = dependencies.materialization
    this.#pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > DEFAULT_PAGE_SIZE) {
      throw new MaterializationOutboxError('INVALID_MESSAGE', `pageSize must be between 1 and ${String(DEFAULT_PAGE_SIZE)}`)
    }
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    switch (message.topic) {
      case REQUEST_TOPIC:
        await this.#advance(message, ctx)
        return
      case PUBLICATION_PUBLISHED_TOPIC:
        await this.#requestForPublication(message, ctx)
        return
      case STATEMENT_CORRECTED_TOPIC:
      case STATEMENT_RETRACTED_TOPIC:
        await this.#requestForStatementRevision(message, ctx, message.topic)
        return
      case IDENTITY_SPLIT_TOPIC:
        await this.#requestForIdentitySplit(message, ctx)
        return
      default:
        // Another consumer owns this topic; the router never routes it here.
        return
    }
  }

  async #advance(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    const payload = asRecord(message.payload)
    if (payload === undefined) {
      throw new MaterializationOutboxError('INVALID_MESSAGE', 'the materialization request must be an object')
    }
    const fenceId = requiredString(payload, 'fenceId')
    const change = parseMaterializationChange(payload['change'])
    const ticket: MaterializationTicket = {
      change,
      fenceId,
      // Empty affected sets: `advance` resolves the affected rules and propositions from the
      // dependency index, exactly as if `beginChange` had just produced the ticket.
      affectedRuleIds: [],
      affectedPropositionKeys: [],
      deferred: false,
    }
    await this.#materializer.advance(ticket, ctx)
  }

  async #requestForPublication(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    const scopeRef = scopeOf(ctx)
    const publicationId = requiredString(message.payload, 'publicationId')
    const publication = await this.#publications.getPublication(scopeRef, publicationId, ctx)
    if (publication === undefined) {
      throw new MaterializationOutboxError(
        'PUBLICATION_NOT_VISIBLE',
        `publication ${publicationId} is not visible in this scope`,
      )
    }
    const fences = parseFenceBindings(message.payload)
    const statements = await this.#listPublicationStatements(scopeRef, publicationId, ctx)
    for (const statement of statements) {
      await this.#openAndEnqueue(
        scopeRef,
        statement.statementId,
        message.jobId,
        (recordedSeq, recordedAt) => ({
          changeId: statement.statementId,
          scopeRef,
          recordedSeq,
          recordedAt,
          kind: 'assertion_published',
          logicalAssertionId: statement.statementId,
          predicate: statement.predicate,
          ...(statement.subjectEntityId === undefined
            ? {}
            : { subjectEntityId: statement.subjectEntityId }),
          validity: validityOf(statement),
        }),
        ctx,
        fences.get(statement.statementId),
      )
    }
    const rules = await this.#listPublicationRules(scopeRef, publicationId, ctx)
    for (const rule of rules) {
      await this.#openAndEnqueue(
        scopeRef,
        rule.ruleVersionId,
        message.jobId,
        (recordedSeq, recordedAt) => ({
          changeId: rule.ruleVersionId,
          scopeRef,
          recordedSeq,
          recordedAt,
          kind: 'rule_changed',
          ruleId: rule.ruleId,
          propositionKey: rule.objectId,
        }),
        ctx,
        fences.get(rule.ruleVersionId),
      )
    }
  }

  async #listPublicationStatements(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]> {
    const records: PublishedStatement[] = []
    const seen = new Set<string>()
    let afterStatementId: Uuid | undefined
    while (true) {
      const page = await this.#publications.listStatements(scopeRef, {
        publicationId,
        limit: this.#pageSize,
        ...(afterStatementId === undefined ? {} : { afterStatementId }),
      }, ctx)
      if (page.length > this.#pageSize || records.length + page.length > MAX_PUBLICATION_SCAN) {
        throw new MaterializationOutboxError(
          'PUBLICATION_SCAN_LIMIT',
          `publication ${publicationId} exceeds the bounded ${String(MAX_PUBLICATION_SCAN)}-record materialization scan`,
        )
      }
      let previous = afterStatementId
      for (const statement of page) {
        if (previous !== undefined && statement.statementId <= previous) {
          throw new MaterializationOutboxError('INVALID_MESSAGE', 'published statement page cursor repeated or moved backwards')
        }
        if (seen.has(statement.statementId)) {
          throw new MaterializationOutboxError('INVALID_MESSAGE', `published statement ${statement.statementId} repeated across pages`)
        }
        seen.add(statement.statementId)
        records.push(statement)
        previous = statement.statementId
      }
      if (page.length < this.#pageSize) return records
      const last = page.at(-1)?.statementId
      if (last === undefined || last === afterStatementId) {
        throw new MaterializationOutboxError('INVALID_MESSAGE', 'published statement page did not advance its keyset cursor')
      }
      afterStatementId = last
    }
  }

  async #listPublicationRules(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]> {
    const records: PublishedRuleVersion[] = []
    const seen = new Set<string>()
    let afterRule: { ruleId: string; version: RevisionString } | undefined
    while (true) {
      const page = await this.#publications.listRuleVersions(scopeRef, {
        publicationId,
        limit: this.#pageSize,
        ...(afterRule === undefined ? {} : { afterRule }),
      }, ctx)
      if (page.length > this.#pageSize || records.length + page.length > MAX_PUBLICATION_SCAN) {
        throw new MaterializationOutboxError(
          'PUBLICATION_SCAN_LIMIT',
          `publication ${publicationId} exceeds the bounded ${String(MAX_PUBLICATION_SCAN)}-rule materialization scan`,
        )
      }
      let previous = afterRule
      for (const rule of page) {
        if (previous !== undefined && compareRulePosition(rule, previous) <= 0) {
          throw new MaterializationOutboxError('INVALID_MESSAGE', 'published rule page cursor repeated or moved backwards')
        }
        const key = `${rule.ruleId}\u0000${rule.version}`
        if (seen.has(key)) throw new MaterializationOutboxError('INVALID_MESSAGE', `published rule ${key} repeated across pages`)
        seen.add(key)
        records.push(rule)
        previous = rule
      }
      if (page.length < this.#pageSize) return records
      const last = page.at(-1)
      if (last === undefined || (afterRule !== undefined && compareRulePosition(last, afterRule) <= 0)) {
        throw new MaterializationOutboxError('INVALID_MESSAGE', 'published rule page did not advance its keyset cursor')
      }
      afterRule = { ruleId: last.ruleId, version: last.version }
    }
  }

  async #requestForIdentitySplit(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    const scopeRef = scopeOf(ctx)
    const payload = asRecord(message.payload)
    if (payload === undefined) throw new MaterializationOutboxError('INVALID_MESSAGE', 'identity split event must be an object')
    const eventId = requiredString(payload, 'eventId')
    const changeId = eventId
    const entityId = requiredString(payload, 'entityId')
    const objectId = requiredString(payload, 'objectId')
    requiredString(payload, 'decisionId')
    requiredString(payload, 'identityScopeId')
    const separatedCandidateIds = parseUuidArray(payload['separatedCandidateIds'])
    const reason = requiredString(payload, 'reason')
    const preOpenedFenceId = requiredString(payload, 'materializationFenceId')
    await this.#openAndEnqueue(
      scopeRef,
      changeId,
      message.jobId,
      (recordedSeq, recordedAt) => ({
        changeId,
        scopeRef,
        recordedSeq,
        recordedAt,
        kind: 'identity_changed',
        entityId,
        objectId,
        separatedCandidateIds,
        reason,
      }),
      ctx,
      preOpenedFenceId,
    )
  }

  async #requestForStatementRevision(
    message: OutboxMessageRecord,
    ctx: ToolContext,
    topic: string,
  ): Promise<void> {
    const scopeRef = scopeOf(ctx)
    const statementId = requiredString(message.payload, 'statementId')
    // The publication service always pins `revisionId`; fall back to the stable outbox id so a
    // re-delivery still resolves the same change (and therefore the same record sequence).
    const revisionId = optionalString(message.payload['revisionId']) ?? message.outboxId
    const statement = await this.#publications.getStatement(scopeRef, statementId, ctx)
    if (statement === undefined) {
      throw new MaterializationOutboxError(
        'STATEMENT_NOT_VISIBLE',
        `statement ${statementId} is not visible in this scope`,
      )
    }
    const kind = topic === STATEMENT_RETRACTED_TOPIC ? 'assertion_retracted' : 'assertion_corrected'
    const fences = parseFenceBindings(message.payload)
    await this.#openAndEnqueue(
      scopeRef,
      revisionId,
      message.jobId,
      (recordedSeq, recordedAt) => ({
        changeId: revisionId,
        scopeRef,
        recordedSeq,
        recordedAt,
        kind,
        logicalAssertionId: statementId,
        predicate: statement.predicate,
        ...(statement.subjectEntityId === undefined ? {} : { subjectEntityId: statement.subjectEntityId }),
        validity: validityOf(statement),
      }),
      ctx,
      fences.get(revisionId),
    )
  }

  /**
   * Enqueue the asynchronous advance request for one change.
   *
   * When the publication/revision transaction already opened the fence, `preOpenedFenceId` is
   * supplied and the consumer reuses it: the window between the commit and this consumption is
   * therefore already covered, and the worker only advances (LOCAL-070). Otherwise (a legacy
   * message without a binding) the consumer opens the fence here, before enqueuing, as before.
   * A fence the consumer opened itself is released again if the enqueue fails, so a retried
   * delivery starts from a clean state; a fence opened by the transaction is never released here.
   */
  async #openAndEnqueue(
    scopeRef: ScopeRef,
    changeId: Uuid,
    jobId: Uuid,
    build: (recordedSeq: RevisionString, recordedAt: Rfc3339UtcTimestamp) => MaterializationChange,
    ctx: ToolContext,
    preOpenedFenceId?: Uuid,
  ): Promise<void> {
    const recordedAt = this.#now()
    const recordedSeq = await this.#sequence.next(scopeRef, `materialization:${changeId}`, ctx)
    const change = build(recordedSeq, recordedAt)
    let fenceId = preOpenedFenceId
    if (fenceId === undefined) {
      const ticket = await this.#materializer.beginChange(change, ctx)
      fenceId = ticket.fenceId
    }
    const message: NewOutboxMessage = {
      outboxId: this.#newId(),
      topic: REQUEST_TOPIC,
      payload: { fenceId, change: serializeMaterializationChange(change) },
      idempotencyKey: `materialization-request:${fenceId}`,
      availableAt: recordedAt,
      createdAt: recordedAt,
    }
    try {
      await this.#outbox.appendOutbox(scopeRef, jobId, message, ctx)
    } catch (error) {
      if (preOpenedFenceId === undefined) await this.#releaseFence(scopeRef, fenceId, ctx)
      throw error
    }
  }

  async #releaseFence(scopeRef: ScopeRef, fenceId: Uuid, ctx: ToolContext): Promise<void> {
    try {
      await this.#materialization.closeFence(scopeRef, fenceId, this.#now(), ctx)
    } catch {
      // The fence is best-effort released; the original enqueue error is the one that matters.
    }
  }
}

/**
 * Allocate the platform record sequence from the control `semantic_events` stream (D2/D5). The
 * stream is per space, so the returned sequence is monotonic across every change in the scope
 * and the projection watermark cannot collide between two different changes.
 */
export function controlRecordSequence(
  repository: ControlRepository,
  streamRef = 'semantic.materialization',
): MaterializationRecordSequence {
  return {
    async next(scopeRef, idempotencyKey, ctx) {
      const response = await repository.appendEvent(
        {
          scopeRef,
          streamRef,
          payloadDigest: sha256DigestOf({ streamRef, idempotencyKey }),
          idempotencyKey,
        },
        ctx,
      )
      return response.recordedSeq
    },
  }
}
