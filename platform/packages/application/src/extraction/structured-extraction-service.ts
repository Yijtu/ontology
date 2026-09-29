import { isToolContext } from '@ontology/contracts'
import type {
  CandidateAttributeValue,
  CandidateIssue,
  CandidateRecord,
  CandidateStore,
  EntityCandidate,
  ExtractionInputVersion,
  IndustryAttributeSchema,
  IndustryObjectSchema,
  IndustrySchema,
  IndustrySchemaSource,
  JobStageCounts,
  ScopedArtifactReader,
  ScopeRef,
  StructuredCandidateSourceSpan,
  StructuredCell,
  StructuredDocumentParserPort,
  StructuredIngestionStore,
  StructuredRecord,
  StructuredRecordEntry,
  StructuredTable,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { StructuredExtractionRef } from '../jobs/structured-ingestion-ref'
import { candidateIdFor, canonicalJson, sha256DigestOf } from './canonical'
import { ExtractionError } from './errors'
import { buildSchemaContext } from './schema-context'

/**
 * The durable structured `parsed → extracted` stage (V03-006 → V03-007).
 *
 * A structured ingestion job's `parsed` stage leaves a `StructuredExtractionRef` in the job's
 * opaque `documentRef` instead of a text `ExtractionJobRef`. This service consumes that
 * reference plus the reconciled `document_structured_records`, re-reads the located cells from
 * the immutable original through the scoped reader, and batch-inserts entity candidates whose
 * source spans carry the exact `SourceLocator`. Values keep both the verbatim raw token and,
 * for a quantity, the exact decimal, so a price/measurement never loses precision through a
 * JavaScript `Number` (A §5.3, P.US-008.AC-02).
 *
 * A field that is not declared by the resolved object becomes an explicit review issue, so a
 * candidate reaches `pending_review` rather than being dropped or published by the model
 * (P.US-008.AC-03).
 */

const RECORD_PAGE_LIMIT = 500
const CANDIDATE_INSERT_BATCH = 200
const DECIMAL_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export interface StructuredExtractionRunContext {
  readonly jobId: Uuid
  readonly ledgerId: Uuid
  readonly pipelineVersion: ExtractionInputVersion['pipelineVersion']
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}

export interface StructuredExtractionResult {
  readonly candidateIds: readonly Uuid[]
  readonly counts: JobStageCounts
}

export interface StructuredExtractionServiceDependencies {
  readonly schemaSource: IndustrySchemaSource
  readonly candidates: CandidateStore
  readonly ingestion: StructuredIngestionStore
  /** Reads the immutable original bytes through the trusted tenant/space scope. */
  readonly originals: ScopedArtifactReader
  /** The pure structured parser; re-reads the located cells without a lossy re-encode. */
  readonly parser: StructuredDocumentParserPort
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ExtractionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ExtractionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExtractionError('CANCELLED', 'the structured extraction stage was cancelled')
  }
}

/**
 * The durable source-row key the structured ingestion adapter writes. It is repeated here so a
 * re-parse can be matched row-for-row against `document_structured_records`; the real
 * PostgreSQL integration test pins the two derivations together.
 */
function sourceRowKeyOf(format: string, sheetKey: string, row: number): string {
  return `${format}:${sheetKey}:row:${row}`
}

function recordRowKeyOf(format: string, recordRef: string): string {
  return `${format}:${recordRef}`
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function pointerKeyOf(locator: StructuredCell['locator']): string | undefined {
  if (locator.kind !== 'json_pointer') return undefined
  const segments = locator.pointer.split('/')
  const last = segments[segments.length - 1]
  return last === undefined || last.length === 0 ? undefined : unescapePointerToken(last)
}

/** A located cell with the schema key it addresses (a column header or a JSON leaf key). */
interface LocatedField {
  readonly key: string
  readonly cell: StructuredCell
}

function fieldsOfTableRow(table: StructuredTable, row: StructuredTable['rows'][number]): LocatedField[] {
  const fields: LocatedField[] = []
  row.cells.forEach((cell, index) => {
    const column = table.columns[index]
    if (column === undefined) return
    fields.push({ key: column.header, cell })
  })
  return fields
}

function fieldsOfRecord(record: StructuredRecord): LocatedField[] {
  const fields: LocatedField[] = []
  for (const cell of record.cells) {
    const key = pointerKeyOf(cell.locator)
    if (key !== undefined) fields.push({ key, cell })
  }
  return fields
}

function attributeValueOf(attribute: IndustryAttributeSchema, cell: StructuredCell): CandidateAttributeValue | undefined {
  const unit = attribute.unitCode === undefined ? {} : { unitCode: attribute.unitCode }
  switch (cell.kind) {
    case 'empty':
    case 'error':
      return undefined
    case 'number':
      return {
        attributeId: attribute.attributeId,
        // The exact decimal is the canonical value; a non-canonical token falls back to its
        // verbatim raw form and is rejected by validation instead of being rewritten.
        value: cell.decimal ?? cell.raw,
        raw: cell.raw,
        ...(cell.decimal === undefined ? {} : { decimal: cell.decimal }),
        ...unit,
      }
    case 'boolean':
      return { attributeId: attribute.attributeId, value: cell.value, raw: cell.raw, ...unit }
    case 'formula':
      return {
        attributeId: attribute.attributeId,
        value: cell.decimal ?? cell.cachedRaw ?? cell.raw,
        raw: cell.raw,
        ...(cell.decimal === undefined ? {} : { decimal: cell.decimal }),
        ...unit,
      }
    case 'text':
    case 'date': {
      // A quantity written as a canonical decimal string keeps the exact token as its decimal;
      // a non-canonical string stays raw-only and is rejected by validation, never rewritten.
      const exact = attribute.valueType === 'quantity' && DECIMAL_TOKEN.test(cell.raw) ? cell.raw : undefined
      return {
        attributeId: attribute.attributeId,
        value: cell.raw,
        raw: cell.raw,
        ...(exact === undefined ? {} : { decimal: exact }),
        ...unit,
      }
    }
  }
}

/**
 * Resolve which declared object a row describes. A row that carries every identity attribute
 * of an object's identity scope is a strong native match; otherwise the object with the most
 * declared attribute keys is used so a recognisable row still reaches review.
 */
function resolveObject(
  schema: IndustrySchema,
  cells: ReadonlyMap<string, StructuredCell>,
): { readonly object: IndustryObjectSchema; readonly deterministic: boolean } | undefined {
  for (const object of schema.objects) {
    const scope = schema.identityScopes.find((entry) => entry.identityScopeId === object.identityScopeId)
    if (scope === undefined || scope.identityAttributeIds.length === 0) continue
    if (scope.identityAttributeIds.every((attributeId) => cells.has(attributeId))) {
      return { object, deterministic: true }
    }
  }
  let best: { readonly object: IndustryObjectSchema; readonly matches: number } | undefined
  for (const object of schema.objects) {
    const matches = object.attributes.filter((attribute) => cells.has(attribute.attributeId)).length
    if (matches === 0) continue
    if (best === undefined || matches > best.matches) best = { object, matches }
  }
  return best === undefined ? undefined : { object: best.object, deterministic: false }
}

function nativeIdOf(
  schema: IndustrySchema,
  object: IndustryObjectSchema,
  cells: ReadonlyMap<string, StructuredCell>,
): string | undefined {
  const scope = schema.identityScopes.find((entry) => entry.identityScopeId === object.identityScopeId)
  if (scope === undefined || scope.identityAttributeIds.length === 0) return undefined
  const entries: [string, string][] = []
  for (const attributeId of scope.identityAttributeIds) {
    const cell = cells.get(attributeId)
    if (cell === undefined || cell.kind === 'empty' || cell.kind === 'error') return undefined
    entries.push([attributeId, cell.raw])
  }
  const first = entries[0]
  if (entries.length === 1 && first !== undefined) return first[1]
  return canonicalJson(Object.fromEntries(entries))
}

function structuredSpanOf(parseId: Uuid, entry: StructuredRecordEntry): StructuredCandidateSourceSpan {
  return {
    kind: 'structured',
    parseId,
    recordId: entry.recordId,
    sourceRowKey: entry.sourceRowKey,
    locator: entry.locator,
    rowDigest: entry.rowDigest,
  }
}

export class StructuredExtractionService {
  readonly #schemaSource: IndustrySchemaSource
  readonly #candidates: CandidateStore
  readonly #ingestion: StructuredIngestionStore
  readonly #originals: ScopedArtifactReader
  readonly #parser: StructuredDocumentParserPort
  readonly #now: () => string

  constructor(dependencies: StructuredExtractionServiceDependencies) {
    this.#schemaSource = dependencies.schemaSource
    this.#candidates = dependencies.candidates
    this.#ingestion = dependencies.ingestion
    this.#originals = dependencies.originals
    this.#parser = dependencies.parser
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** `parsed → extracted` for a structured ingestion job. */
  async extract(
    ref: StructuredExtractionRef,
    run: StructuredExtractionRunContext,
  ): Promise<StructuredExtractionResult> {
    const scopeRef = scopeOf(run.ctx)
    const schema = await this.#requireSchema(scopeRef, ref.definitionRef, run.ctx)
    const schemaContext = buildSchemaContext(schema)
    throwIfAborted(run.signal)

    const located = await this.#reparse(ref, run)
    const inputVersion: ExtractionInputVersion = {
      definitionRef: ref.definitionRef,
      parseId: ref.parseId,
      parserVersion: ref.parserVersion,
      pipelineVersion: run.pipelineVersion,
      ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
      promptVersion: schemaContext.promptVersion,
      schemaDigest: schemaContext.digest,
    }
    const recordedAt = this.#now()

    const records: CandidateRecord[] = []
    let failed = 0
    let skipped = 0
    let cursor: string | undefined
    for (;;) {
      throwIfAborted(run.signal)
      const page = await this.#ingestion.listRecords(
        scopeRef,
        ref.parseId,
        { limit: RECORD_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        run.ctx,
      )
      for (const entry of page.records) {
        if (entry.state === 'failed') {
          failed += 1
          continue
        }
        if (entry.state !== 'parsed') {
          skipped += 1
          continue
        }
        const fields = located.get(entry.sourceRowKey)
        if (fields === undefined) {
          // A durable `parsed` row with no matching re-parsed record would silently lose data,
          // so it is refused instead of being dropped.
          throw new ExtractionError(
            'STRUCTURED_PARSE_REJECTED',
            `the durable structured row ${entry.sourceRowKey} cannot be re-read from the original`,
          )
        }
        const record = this.#entityRecord({
          inputVersion,
          recordedAt,
          schema,
          entry,
          fields,
          jobId: run.jobId,
        })
        if (record === undefined) {
          skipped += 1
          continue
        }
        records.push(record)
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }

    const candidateIds = await this.#insert(run, records)
    return {
      candidateIds,
      counts: {
        total: records.length + failed + skipped,
        processed: candidateIds.length,
        failed,
        skipped,
      },
    }
  }

  async #requireSchema(
    scopeRef: ScopeRef,
    definitionRef: ExtractionInputVersion['definitionRef'],
    ctx: ToolContext,
  ): Promise<IndustrySchema> {
    const schema = await this.#schemaSource.getSchema(scopeRef, definitionRef, ctx)
    if (schema === undefined) {
      throw new ExtractionError(
        'SCHEMA_NOT_FOUND',
        `definition ${definitionRef.id}@${definitionRef.version} is not visible in this scope`,
      )
    }
    return schema
  }

  async #reparse(
    ref: StructuredExtractionRef,
    run: StructuredExtractionRunContext,
  ): Promise<ReadonlyMap<string, readonly LocatedField[]>> {
    let bytes: Uint8Array
    try {
      bytes = await this.#originals.read({ approvedInputRefs: [ref.originalRef] }, run.ctx)
    } catch (error) {
      throw new ExtractionError('ORIGINAL_UNREADABLE', 'the immutable original could not be read', {
        cause: error,
      })
    }
    const result = this.#parser.parse(bytes, { ...ref.options, mediaType: ref.originalMediaType })
    if (result.status === 'rejected') {
      throw new ExtractionError(
        'STRUCTURED_PARSE_REJECTED',
        result.diagnostics[0]?.message ?? 'the structured original was rejected on re-parse',
      )
    }
    const index = new Map<string, readonly LocatedField[]>()
    for (const table of result.tables) {
      const sheetKey = table.sheetId ?? table.sheetName ?? 'sheet'
      for (const row of table.rows) {
        index.set(sourceRowKeyOf(table.format, sheetKey, row.row), fieldsOfTableRow(table, row))
      }
    }
    for (const record of result.records) {
      index.set(recordRowKeyOf(result.format, record.recordRef), fieldsOfRecord(record))
    }
    return index
  }

  #entityRecord(args: {
    readonly inputVersion: ExtractionInputVersion
    readonly recordedAt: string
    readonly schema: IndustrySchema
    readonly entry: StructuredRecordEntry
    readonly fields: readonly LocatedField[]
    readonly jobId: Uuid
  }): EntityCandidate | undefined {
    const cells = new Map<string, StructuredCell>()
    for (const field of args.fields) cells.set(field.key, field.cell)
    const resolved = resolveObject(args.schema, cells)
    if (resolved === undefined) return undefined
    const { object, deterministic } = resolved
    const attributes: CandidateAttributeValue[] = []
    const issues: CandidateIssue[] = []
    for (const field of args.fields) {
      const attribute = object.attributes.find((candidate) => candidate.attributeId === field.key)
      if (attribute === undefined) {
        // An unknown field is kept as an explicit review issue rather than dropped; the soft
        // issue keeps the candidate in `pending_review` (P.US-008.AC-03).
        issues.push({
          code: 'UNKNOWN_ATTRIBUTE',
          message: `field ${field.key} is not declared on object ${object.objectId}`,
          field: `attributes.${field.key}`,
        })
        continue
      }
      const value = attributeValueOf(attribute, field.cell)
      if (value !== undefined) attributes.push(value)
    }
    const sortedAttributes = [...attributes].sort((left, right) =>
      left.attributeId < right.attributeId ? -1 : 1,
    )
    const nativeId = deterministic ? nativeIdOf(args.schema, object, cells) : undefined
    const idempotencyKey = sha256DigestOf(
      canonicalJson({
        jobId: args.jobId,
        recordId: args.entry.recordId,
        kind: 'entity',
        objectId: object.objectId,
        attributes: sortedAttributes,
      }),
    )
    return {
      kind: 'entity',
      candidateId: candidateIdFor(idempotencyKey),
      jobId: args.jobId,
      objectId: object.objectId,
      identityScopeId: object.identityScopeId,
      ...(nativeId === undefined ? {} : { nativeId }),
      attributes,
      sourceSpans: [structuredSpanOf(args.inputVersion.parseId, args.entry)],
      deterministic,
      state: 'produced',
      issues,
      inputVersion: args.inputVersion,
      idempotencyKey,
      recordedAt: args.recordedAt,
    }
  }

  async #insert(
    run: StructuredExtractionRunContext,
    records: readonly CandidateRecord[],
  ): Promise<readonly Uuid[]> {
    const ids: Uuid[] = []
    for (let offset = 0; offset < records.length; offset += CANDIDATE_INSERT_BATCH) {
      const batch = records.slice(offset, offset + CANDIDATE_INSERT_BATCH)
      const result = await this.#candidates.insertCandidates(scopeOf(run.ctx), batch, run.ctx)
      ids.push(...result.candidateIds)
    }
    return ids
  }
}
