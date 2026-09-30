import { ProjectMappingStoreError, isToolContext } from '@ontology/contracts'
import type {
  BindRecordsRequest,
  BindRecordsResult,
  ColumnMappingEntry,
  ColumnMappingRequest,
  ColumnPreview,
  ExactUnitConversion,
  ImportMappingVersion,
  IndustryAttributeSchema,
  IndustryObjectSchema,
  IndustrySchema,
  IndustrySchemaSource,
  MappingIssue,
  MappingPreview,
  MappingSample,
  MappingUnmappedColumn,
  MappingRef,
  NewProjectRecordVersion,
  NormalizedProjectFieldValue,
  ProjectMappingStore,
  ProjectRecordCounts,
  ProjectRecordFieldStatus,
  ProjectRecordFieldValue,
  ProjectRecordStore,
  RevisionString,
  ScopedArtifactReader,
  ScopeRef,
  Semver,
  Sha256Digest,
  SourceLocator,
  StructuredCell,
  StructuredDocumentParserPort,
  StructuredIngestionStore,
  StructuredParseIssue,
  StructuredParseResult,
  StructuredParseStatus,
  StructuredSheetInfo,
  StructuredTable,
  ToolContext,
  Uuid,
  UnitCode,
  VersionRef,
} from '@ontology/contracts'
import { assertImportMappingVersionShape } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { applyExactFactor, isDecimalString } from './decimal'
import { ProjectError } from './errors'

const MAPPING_EDITOR_ROLES: readonly string[] = ['platform-admin', 'profile-editor']
const SAMPLE_LIMIT = 5
const RECORD_PAGE_LIMIT = 500
const MAX_BIND_RECORDS = 20_000

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ProjectError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProjectError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (MAPPING_EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new ProjectError('FORBIDDEN', 'only a profile-editor or platform-admin may confirm project mappings')
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new ProjectError('INVALID_ARGUMENT', 'Idempotency-Key must be a string between 8 and 256 characters')
  }
  return key
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/gu, '/').replace(/~0/gu, '~')
}

function pointerKeyOf(locator: SourceLocator): string | undefined {
  if (locator.kind !== 'json_pointer') return undefined
  const segments = locator.pointer.split('/')
  const last = segments[segments.length - 1]
  return last === undefined || last.length === 0 ? undefined : unescapePointerToken(last)
}

function headerDigestOf(header: string): Sha256Digest {
  return sha256DigestOf(header)
}

function sourceRowKeyOf(format: string, sheetKey: string, row: number): string {
  return `${format}:${sheetKey}:row:${row}`
}

function recordRowKeyOf(format: string, recordRef: string): string {
  return `${format}:${recordRef}`
}

/** A selected sheet's columns in parser order, with the stable 0-based index. */
interface ReparsedColumn {
  readonly index: number
  readonly header: string
  readonly headerDigest: Sha256Digest
}

interface ReparsedRow {
  readonly recordIndex: number
  readonly row: number
  readonly cells: readonly StructuredCell[]
  readonly byKey: ReadonlyMap<string, StructuredCell>
}

interface ReparsedKey {
  readonly index: number
  readonly key: string
  readonly pointer: string
}

interface Reparsed {
  readonly status: StructuredParseStatus
  readonly diagnostics: readonly StructuredParseIssue[]
  readonly sheets: readonly StructuredSheetInfo[]
  readonly format: StructuredParseResult['format']
  /** Table selection (CSV/XLSX). `undefined` for JSON/text and when the sheet is ambiguous. */
  readonly sheet?: {
    readonly sheetId?: string
    readonly sheetName?: string
    readonly columns: readonly ReparsedColumn[]
    readonly rows: readonly ReparsedRow[]
    readonly ambiguous: boolean
  }
  /** JSON/text record selection. */
  readonly recordSet?: {
    readonly keys: readonly ReparsedKey[]
    readonly rows: readonly ReparsedRow[]
  }
  /** True when an explicit worksheet was requested but the original does not contain it. */
  readonly selectionMissing?: boolean
  readonly bySourceRowKey: ReadonlyMap<string, ReparsedRow>
}

interface NormalizeOutcome {
  readonly normalized?: NormalizedProjectFieldValue
  readonly raw: string
  readonly status: ProjectRecordFieldStatus
  readonly reason?: string
  readonly sourceUnitCode?: UnitCode
  readonly canonical?: string
  readonly missing: boolean
}

/**
 * Locate the cell for one correspondence. A table is addressed by its 0-based column position
 * (so two columns sharing a header text never collide); a JSON/text record is keyed by its leaf
 * pointer. Both were validated against the parser digest at confirmation time.
 */
function cellFor(
  row: ReparsedRow,
  entry: ColumnMappingEntry,
  records: boolean,
): StructuredCell | undefined {
  return records ? row.byKey.get(entry.header) : row.cells[entry.columnIndex]
}

function decimalTokenOf(cell: StructuredCell): string | undefined {
  if (cell.kind === 'number') return cell.decimal ?? (isDecimalString(cell.raw) ? cell.raw : undefined)
  if (cell.kind === 'formula') {
    return cell.decimal ?? (cell.cachedRaw !== undefined && isDecimalString(cell.cachedRaw) ? cell.cachedRaw : undefined)
  }
  return isDecimalString(cell.raw) ? cell.raw : undefined
}

function applyValueMapping(entry: ColumnMappingEntry, raw: string): string {
  const match = entry.valueMapping?.find((mapping) => mapping.from === raw)
  return match === undefined ? raw : match.to
}

function conversionIsWellFormed(
  conversion: ExactUnitConversion,
  sourceUnit: UnitCode,
  canonicalUnit: UnitCode,
): boolean {
  return conversion.fromUnitCode === sourceUnit && conversion.toUnitCode === canonicalUnit
}

function normalizeCell(
  attribute: IndustryAttributeSchema,
  entry: ColumnMappingEntry,
  cell: StructuredCell | undefined,
): NormalizeOutcome {
  if (cell === undefined || cell.kind === 'empty' || cell.kind === 'error') {
    return { raw: cell?.raw ?? '', status: 'pending', missing: true, reason: 'MISSING_VALUE' }
  }
  const raw = cell.raw
  if (attribute.valueType === 'quantity') {
    const canonicalUnit = attribute.unitCode
    if (canonicalUnit === undefined) {
      return { raw, status: 'conflict', missing: false, reason: 'ATTRIBUTE_HAS_NO_UNIT' }
    }
    const decimal = decimalTokenOf(cell)
    if (decimal === undefined) {
      return { raw, status: 'conflict', missing: false, reason: 'INVALID_DECIMAL' }
    }
    const source = entry.sourceUnitCode
    if (source !== undefined && source === canonicalUnit) {
      return {
        raw,
        status: 'confirmed',
        missing: false,
        normalized: { kind: 'quantity', value: decimal, unitCode: canonicalUnit },
        canonical: decimal,
        sourceUnitCode: source,
      }
    }
    if (source !== undefined && entry.unitConversion !== undefined && conversionIsWellFormed(entry.unitConversion, source, canonicalUnit)) {
      const converted = applyExactFactor(decimal, entry.unitConversion.numerator, entry.unitConversion.denominator)
      if (converted !== undefined) {
        return {
          raw,
          status: 'confirmed',
          missing: false,
          normalized: { kind: 'quantity', value: converted, unitCode: canonicalUnit },
          canonical: converted,
          sourceUnitCode: source,
        }
      }
      return { raw, status: 'pending', missing: false, reason: 'INEXACT_CONVERSION', sourceUnitCode: source }
    }
    return {
      raw,
      status: 'pending',
      missing: false,
      reason: source === undefined ? 'MISSING_UNIT' : 'MISSING_UNIT_CONVERSION',
      ...(source === undefined ? {} : { sourceUnitCode: source }),
    }
  }

  const mapped = applyValueMapping(entry, raw)
  const scalar = (value: string | boolean | null): NormalizeOutcome => ({
    raw,
    status: 'confirmed',
    missing: false,
    normalized: { kind: 'scalar', value },
    canonical: value === null ? '' : String(value),
  })
  if (entry.sourceUnitCode !== undefined || entry.canonicalUnitCode !== undefined) {
    return { raw, status: 'pending', missing: false, reason: 'UNIT_ON_NON_QUANTITY' }
  }
  switch (attribute.valueType) {
    case 'boolean': {
      if (cell.kind === 'boolean') return scalar(cell.value)
      if (mapped === 'true') return scalar(true)
      if (mapped === 'false') return scalar(false)
      return { raw, status: 'conflict', missing: false, reason: 'TYPE_MISMATCH' }
    }
    case 'number':
      return isDecimalString(mapped)
        ? scalar(mapped)
        : { raw, status: 'conflict', missing: false, reason: 'TYPE_MISMATCH' }
    case 'enum': {
      if (attribute.enumValues !== undefined && attribute.enumValues.length > 0 && !attribute.enumValues.includes(mapped)) {
        return { raw, status: 'conflict', missing: false, reason: 'VALUE_NOT_MAPPED' }
      }
      return scalar(mapped)
    }
    case 'string':
    case 'timestamp':
    case 'reference':
      return scalar(mapped)
  }
}

function issue(
  code: MappingIssue['code'],
  severity: MappingIssue['severity'],
  message: string,
  extra: Omit<MappingIssue, 'code' | 'severity' | 'message'> = {},
): MappingIssue {
  return { code, severity, message, ...extra }
}

function diagnosticsAsIssues(diagnostics: readonly StructuredParseIssue[]): MappingIssue[] {
  return diagnostics.map((diagnostic) => ({
    code:
      diagnostic.code === 'UNSUPPORTED_TABLE_LAYOUT' ||
      diagnostic.code === 'UNSUPPORTED_MULTI_LEVEL_HEADER' ||
      diagnostic.code === 'MERGED_CELLS' ||
      diagnostic.code === 'MISSING_SHEET'
        ? 'UNSUPPORTED_TABLE_LAYOUT'
        : 'UNSUPPORTED_MEDIA_TYPE',
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.sheetName === undefined ? {} : { header: diagnostic.sheetName }),
    ...(diagnostic.row === undefined ? {} : { recordIndex: diagnostic.row }),
  }))
}

/**
 * Column-mapping confirmation, unit normalisation and project-record binding
 * (SPEC v0.3a §3.3/§5/§6.2, A.US-002/A.US-006/P.US-008/P.US-013).
 *
 * `preview` re-reads the immutable original through the pure parser, matches the caller's
 * explicit correspondence against the parsed headers (never by guessing names), validates the
 * canonical unit and exact conversion per quantity, and shows canonical values next to the
 * original cells. `confirm` persists the correspondence as an immutable mapping version, and
 * `bindRecords` derives stable project-record versions keyed by the original-record identity.
 */
export interface ProjectMappingServiceDependencies {
  readonly projects: { getProject: (scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext) => Promise<{ headRevision: RevisionString } | undefined> }
  readonly revisions: { getRevision: (scopeRef: ScopeRef, projectId: Uuid, revision: RevisionString, ctx: ToolContext) => Promise<{ definitionRef: VersionRef } | undefined> }
  readonly mappings: ProjectMappingStore
  readonly records: ProjectRecordStore
  readonly ingestion: StructuredIngestionStore
  readonly schemaSource: IndustrySchemaSource
  readonly originals: ScopedArtifactReader
  readonly parser: StructuredDocumentParserPort
  readonly newId?: () => string
  readonly now?: () => string
}

export interface ConfirmMappingResult {
  readonly mapping: ImportMappingVersion
  readonly preview: MappingPreview
  readonly created: boolean
}

export class ProjectMappingService {
  readonly #projects: ProjectMappingServiceDependencies['projects']
  readonly #revisions: ProjectMappingServiceDependencies['revisions']
  readonly #mappings: ProjectMappingStore
  readonly #records: ProjectRecordStore
  readonly #ingestion: StructuredIngestionStore
  readonly #schemaSource: IndustrySchemaSource
  readonly #originals: ScopedArtifactReader
  readonly #parser: StructuredDocumentParserPort
  readonly #newId: () => string
  readonly #now: () => string

  constructor(dependencies: ProjectMappingServiceDependencies) {
    this.#projects = dependencies.projects
    this.#revisions = dependencies.revisions
    this.#mappings = dependencies.mappings
    this.#records = dependencies.records
    this.#ingestion = dependencies.ingestion
    this.#schemaSource = dependencies.schemaSource
    this.#originals = dependencies.originals
    this.#parser = dependencies.parser
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async previewMapping(
    projectId: Uuid,
    request: ColumnMappingRequest,
    ctx: ToolContext,
  ): Promise<MappingPreview> {
    const scopeRef = scopeOf(ctx)
    const definitionRef = await this.#requireDefinitionRef(scopeRef, projectId, request.definitionRef, ctx)
    const schema = await this.#requireSchema(scopeRef, definitionRef, ctx)
    const object = schema.objects.find((candidate) => candidate.objectId === request.objectId)
    if (object === undefined) {
      return {
        projectId,
        definitionRef,
        objectId: request.objectId,
        format: request.format,
        parseId: request.parseId,
        columns: [],
        unmappedColumns: [],
        issues: [issue('UNKNOWN_OBJECT', 'error', `object ${request.objectId} is not declared by definition ${definitionRef.id}@${definitionRef.version}`)],
        rowCount: 0,
        confirmable: false,
      }
    }
    const reparsed = await this.#reparse(request, ctx)
    return this.#buildPreview(projectId, definitionRef, object, request, reparsed)
  }

  async confirmMapping(
    projectId: Uuid,
    request: ColumnMappingRequest,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ConfirmMappingResult> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    const preview = await this.previewMapping(projectId, request, ctx)
    if (!preview.confirmable) {
      const first = preview.issues.find((entry) => entry.severity === 'error')
      throw new ProjectError(
        'INVALID_ARGUMENT',
        `the column mapping is not confirmable: ${first?.message ?? 'unsupported structure'}`,
        { reasons: preview.issues.filter((entry) => entry.severity === 'error').map((entry) => `${entry.code}: ${entry.message}`) },
      )
    }
    const mappingId = request.mappingId ?? this.#newId()
    const version = request.mappingId === undefined
      ? '1.0.0'
      : nextVersion(await this.#mappings.latestVersion(scopeRef, projectId, mappingId, ctx))
    const body = {
      definitionRef: preview.definitionRef,
      format: request.format,
      parseId: request.parseId,
      originalMediaType: request.originalMediaType,
      options: request.options,
      objectId: request.objectId,
      sheetId: request.sheetId ?? null,
      sheetName: request.sheetName ?? null,
      entries: [...request.entries].sort((left, right) => left.columnIndex - right.columnIndex),
    }
    const digest = sha256DigestOf(canonicalJson(body))
    const ref: MappingRef = {
      id: mappingId,
      version,
      digest,
      role: 'catalog',
      sourceObjectRef: {
        sourceRef: { namespace: 'project-import', sourceId: mappingId },
        objectPath: request.objectId,
      },
    }
    const mapping: ImportMappingVersion = {
      schemaVersion: 'import-mapping@1',
      projectId,
      mappingId,
      version,
      ref,
      definitionRef: preview.definitionRef,
      format: request.format,
      parseId: request.parseId,
      originalRef: request.originalRef,
      originalMediaType: request.originalMediaType,
      options: request.options,
      objectId: request.objectId,
      ...(request.sheetId === undefined ? {} : { sheetId: request.sheetId }),
      ...(request.sheetName === undefined ? {} : { sheetName: request.sheetName }),
      entries: body.entries,
      digest,
      actor,
      recordedAt: this.#now(),
    }
    assertImportMappingVersionShape(mapping)
    const requestDigest = sha256DigestOf(canonicalJson(body))
    const result = await this.#mappings.insertMapping(
      scopeRef,
      mapping,
      { idempotencyKey, requestDigest },
      ctx,
    ).catch((error: unknown) => {
      if (error instanceof ProjectMappingStoreError) {
        throw new ProjectError(error.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'INVALID_ARGUMENT', error.message, { cause: error })
      }
      throw error
    })
    return { mapping: result.mapping, preview, created: result.created }
  }

  async bindRecords(
    projectId: Uuid,
    request: BindRecordsRequest,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<BindRecordsResult> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    const project = await this.#requireProject(scopeRef, projectId, ctx)
    const revision = await this.#revisions.getRevision(scopeRef, projectId, project.headRevision, ctx)
    if (revision === undefined) {
      throw new ProjectError('REVISION_NOT_FOUND', `project ${projectId} has no readable head revision`)
    }
    const mapping = await this.#mappings.getMapping(scopeRef, projectId, request.mappingId, request.mappingVersion, ctx)
    if (mapping === undefined) {
      throw new ProjectError('MAPPING_NOT_FOUND', `mapping ${request.mappingId}@${request.mappingVersion} is not visible for this project`)
    }
    if (mapping.definitionRef.digest !== revision.definitionRef.digest) {
      throw new ProjectError(
        'VERSION_CONFLICT',
        'the mapping was confirmed against a different definition version than the project head pins',
      )
    }
    if (mapping.parseId !== request.parseId) {
      throw new ProjectError('INVALID_ARGUMENT', 'the binding parse does not match the parse the mapping was confirmed against')
    }
    const schema = await this.#requireSchema(scopeRef, revision.definitionRef, ctx)
    const object = schema.objects.find((candidate) => candidate.objectId === mapping.objectId)
    if (object === undefined) {
      throw new ProjectError('INVALID_ARGUMENT', `object ${mapping.objectId} is not declared by the mapped definition`)
    }
    const reparsed = await this.#reparse(
      {
        format: mapping.format,
        parseId: mapping.parseId,
        originalRef: mapping.originalRef,
        originalMediaType: mapping.originalMediaType,
        options: mapping.options,
        objectId: mapping.objectId,
        entries: mapping.entries,
        ...(mapping.sheetId === undefined ? {} : { sheetId: mapping.sheetId }),
        ...(mapping.sheetName === undefined ? {} : { sheetName: mapping.sheetName }),
      },
      ctx,
    )
    const entryByField = new Map(mapping.entries.map((entry) => [entry.fieldRef, entry]))
    const recordsMode = reparsed.recordSet !== undefined
    const pending: NewProjectRecordVersion[] = []
    const recordedAt = this.#now()
    let created = false
    let scanned = 0
    let cursor: string | undefined
    for (;;) {
      const page = await this.#ingestion.listRecords(
        scopeRef,
        mapping.parseId,
        { limit: RECORD_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      for (const entry of page.records) {
        if (entry.state !== 'parsed') continue
        scanned += 1
        if (scanned > MAX_BIND_RECORDS) {
          throw new ProjectError('INVALID_ARGUMENT', `a single bind is bounded to ${MAX_BIND_RECORDS} rows`)
        }
        const row = reparsed.bySourceRowKey.get(entry.sourceRowKey)
        if (row === undefined) {
          throw new ProjectError(
            'SOURCE_UNREADABLE',
            `durable structured row ${entry.sourceRowKey} cannot be re-read from the immutable original`,
          )
        }
        pending.push(this.#recordFor(object, entryByField, {
          projectId,
          recordId: entry.recordId,
          mapping,
          sourceRowKey: entry.sourceRowKey,
          sourceDigest: entry.rowDigest,
          row,
          records: recordsMode,
          actor,
          recordedAt,
        }))
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    const result = await this.#records.appendRecords(
      scopeRef,
      projectId,
      pending,
      { idempotencyKey, requestDigest: sha256DigestOf(canonicalJson({ mappingId: mapping.mappingId, version: mapping.version, parseId: mapping.parseId })) },
      ctx,
    )
    created = result.created
    const records = result.records
    const counts: ProjectRecordCounts = {
      total: records.length,
      confirmed: records.filter((record) => record.status === 'confirmed').length,
      pending: records.filter((record) => record.status === 'pending').length,
      conflict: records.filter((record) => record.status === 'conflict').length,
    }
    return { records, counts, created }
  }

  async listRecords(
    projectId: Uuid,
    query: { objectId?: string; status?: ProjectRecordFieldStatus; limit?: number; cursor?: string },
    ctx: ToolContext,
  ) {
    const scopeRef = scopeOf(ctx)
    await this.#requireProject(scopeRef, projectId, ctx)
    return this.#records.listRecords(scopeRef, projectId, query, ctx)
  }

  async getMapping(
    projectId: Uuid,
    mappingId: Uuid,
    version: Semver,
    ctx: ToolContext,
  ): Promise<ImportMappingVersion | undefined> {
    const scopeRef = scopeOf(ctx)
    await this.#requireProject(scopeRef, projectId, ctx)
    return this.#mappings.getMapping(scopeRef, projectId, mappingId, version, ctx)
  }

  async listMappings(projectId: Uuid, ctx: ToolContext): Promise<ImportMappingVersion[]> {
    const scopeRef = scopeOf(ctx)
    await this.#requireProject(scopeRef, projectId, ctx)
    return this.#mappings.listMappings(scopeRef, projectId, ctx)
  }

  #recordFor(
    object: IndustryObjectSchema,
    entryByField: ReadonlyMap<string, ColumnMappingEntry>,
    args: {
      readonly projectId: Uuid
      readonly recordId: Uuid
      readonly mapping: ImportMappingVersion
      readonly sourceRowKey: string
      readonly sourceDigest: Sha256Digest
      readonly row: ReparsedRow
      readonly records: boolean
      readonly actor: string
      readonly recordedAt: string
    },
  ): NewProjectRecordVersion {
    const fields: ProjectRecordFieldValue[] = []
    for (const attribute of object.attributes) {
      const entry = entryByField.get(attribute.attributeId)
      if (entry === undefined) continue
      const cell = cellFor(args.row, entry, args.records)
      const outcome = normalizeCell(attribute, entry, cell)
      if (outcome.missing) continue
      const locator = cell?.locator ?? { kind: 'approximate_locator' as const }
      fields.push({
        fieldId: attribute.attributeId,
        raw: outcome.raw,
        normalized: outcome.normalized ?? { kind: 'scalar', value: outcome.raw },
        ...(outcome.sourceUnitCode === undefined ? {} : { sourceUnitCode: outcome.sourceUnitCode }),
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        locator,
      })
    }
    fields.sort((left, right) => left.fieldId.localeCompare(right.fieldId))
    const status: ProjectRecordFieldStatus = fields.some((field) => field.status === 'conflict')
      ? 'conflict'
      : fields.some((field) => field.status === 'pending')
        ? 'pending'
        : 'confirmed'
    const contentDigest = sha256DigestOf(canonicalJson({ objectId: object.objectId, fields }))
    return {
      schemaVersion: 'project-record@1',
      projectId: args.projectId,
      recordId: args.recordId,
      mappingId: args.mapping.mappingId,
      mappingVersion: args.mapping.version,
      objectId: object.objectId,
      sourceRowKey: args.sourceRowKey,
      sourceDigest: args.sourceDigest,
      contentDigest,
      fields,
      status,
      actor: args.actor,
      recordedAt: args.recordedAt,
    }
  }

  async #requireProject(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<{ headRevision: RevisionString }> {
    const project = await this.#projects.getProject(scopeRef, projectId, ctx)
    if (project === undefined) {
      throw new ProjectError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
    }
    return project
  }

  async #requireDefinitionRef(
    scopeRef: ScopeRef,
    projectId: Uuid,
    requested: VersionRef | undefined,
    ctx: ToolContext,
  ): Promise<VersionRef> {
    const project = await this.#requireProject(scopeRef, projectId, ctx)
    const revision = await this.#revisions.getRevision(scopeRef, projectId, project.headRevision, ctx)
    if (revision === undefined) {
      throw new ProjectError('REVISION_NOT_FOUND', `project ${projectId} has no readable head revision`)
    }
    if (
      requested !== undefined &&
      (requested.id !== revision.definitionRef.id ||
        requested.version !== revision.definitionRef.version ||
        requested.digest !== revision.definitionRef.digest)
    ) {
      throw new ProjectError('INVALID_ARGUMENT', 'the requested definitionRef is not the definition the project head pins')
    }
    return revision.definitionRef
  }

  async #requireSchema(scopeRef: ScopeRef, definitionRef: VersionRef, ctx: ToolContext): Promise<IndustrySchema> {
    const schema = await this.#schemaSource.getSchema(scopeRef, definitionRef, ctx)
    if (schema === undefined) {
      throw new ProjectError('INVALID_ARGUMENT', `definition ${definitionRef.id}@${definitionRef.version} is not visible in this scope`)
    }
    return schema
  }

  async #reparse(request: ColumnMappingRequest, ctx: ToolContext): Promise<Reparsed> {
    let bytes: Uint8Array
    try {
      bytes = await this.#originals.read({ approvedInputRefs: [request.originalRef] }, ctx)
    } catch (error) {
      throw new ProjectError('SOURCE_UNREADABLE', 'the immutable original could not be read', { cause: error })
    }
    const parsed = this.#parser.parse(bytes, { ...request.options, mediaType: request.originalMediaType })
    const bySourceRowKey = new Map<string, ReparsedRow>()
    const base = {
      status: parsed.status,
      diagnostics: parsed.diagnostics,
      sheets: parsed.sheets,
      format: parsed.format,
      bySourceRowKey,
    }
    if (parsed.records.length > 0) {
      const keys = new Map<string, ReparsedKey>()
      const rows: ReparsedRow[] = []
      for (const record of parsed.records) {
        const byKey = new Map<string, StructuredCell>()
        for (const cell of record.cells) {
          const key = pointerKeyOf(cell.locator)
          if (key === undefined) continue
          if (!keys.has(key)) keys.set(key, { index: keys.size, key, pointer: cell.locator.kind === 'json_pointer' ? cell.locator.pointer : key })
          byKey.set(key, cell)
        }
        const row: ReparsedRow = { recordIndex: record.recordIndex, row: record.recordIndex, cells: record.cells, byKey }
        rows.push(row)
        bySourceRowKey.set(recordRowKeyOf(parsed.format, record.recordRef), row)
      }
      return { ...base, recordSet: { keys: [...keys.values()], rows } }
    }
    const candidates = parsed.tables
    let selected: StructuredTable | undefined
    let ambiguous = false
    if (request.sheetId !== undefined || request.sheetName !== undefined) {
      selected = candidates.find((table) =>
        (request.sheetId !== undefined && table.sheetId === request.sheetId) ||
        (request.sheetName !== undefined && table.sheetName === request.sheetName),
      )
    } else if (candidates.length === 1) {
      selected = candidates[0]
    } else if (candidates.length > 1) {
      ambiguous = true
    }
    if (selected !== undefined) {
      const columns: ReparsedColumn[] = selected.columns.map((column) => ({
        index: column.index,
        header: column.header,
        headerDigest: column.headerDigest,
      }))
      const rows: ReparsedRow[] = selected.rows.map((row) => {
        const byKey = new Map<string, StructuredCell>()
        row.cells.forEach((cell, index) => {
          const column = columns[index]
          if (column !== undefined) byKey.set(column.header, cell)
        })
        return { recordIndex: row.recordIndex, row: row.row, cells: row.cells, byKey }
      })
      const sheetKey = selected.sheetId ?? selected.sheetName ?? 'sheet'
      for (const row of rows) {
        bySourceRowKey.set(sourceRowKeyOf(selected.format, sheetKey, row.row), row)
      }
      return {
        ...base,
        sheet: {
          ...(selected.sheetId === undefined ? {} : { sheetId: selected.sheetId }),
          ...(selected.sheetName === undefined ? {} : { sheetName: selected.sheetName }),
          columns,
          rows,
          ambiguous: false,
        },
      }
    }
    if (request.sheetId !== undefined || request.sheetName !== undefined) {
      return { ...base, selectionMissing: true }
    }
    return { ...base, ...(ambiguous ? { sheet: { columns: [], rows: [], ambiguous: true } } : {}) }
  }

  #buildPreview(
    projectId: Uuid,
    definitionRef: VersionRef,
    object: IndustryObjectSchema,
    request: ColumnMappingRequest,
    reparsed: Reparsed,
  ): MappingPreview {
    const issues: MappingIssue[] = []
    if (reparsed.status === 'rejected') {
      issues.push(...diagnosticsAsIssues(reparsed.diagnostics))
      if (issues.length === 0) {
        issues.push(issue('UNSUPPORTED_TABLE_LAYOUT', 'error', 'the original could not be parsed into a supported table or record set'))
      }
      return {
        projectId,
        definitionRef,
        objectId: object.objectId,
        format: request.format,
        parseId: request.parseId,
        columns: [],
        unmappedColumns: [],
        issues,
        rowCount: 0,
        confirmable: false,
      }
    }
    for (const diagnostic of reparsed.diagnostics) {
      if (diagnostic.severity === 'warning') issues.push(...diagnosticsAsIssues([diagnostic]))
    }

    const isRecords = reparsed.recordSet !== undefined
    const columns: readonly ReparsedColumn[] = isRecords
      ? (reparsed.recordSet?.keys ?? []).map((key) => ({ index: key.index, header: key.key, headerDigest: headerDigestOf(key.key) }))
      : (reparsed.sheet?.columns ?? [])
    const rows: readonly ReparsedRow[] = isRecords
      ? (reparsed.recordSet?.rows ?? [])
      : (reparsed.sheet?.rows ?? [])

    if (reparsed.selectionMissing === true) {
      issues.push(issue('MISSING_SHEET', 'error', 'the requested worksheet is not present in the original'))
    }
    if (reparsed.sheet?.ambiguous === true) {
      issues.push(issue('UNSUPPORTED_TABLE_LAYOUT', 'error', 'the workbook has multiple worksheets; an explicit sheetId or sheetName is required'))
    }
    if (columns.length === 0 && rows.length === 0) {
      issues.push(issue('NO_ROWS', 'error', 'the selected source produced no readable columns or rows'))
    }

    const previewColumns: ColumnPreview[] = []
    const seenFields = new Set<string>()
    const referencedHeaders = new Set<string>()

    for (const entry of [...request.entries].sort((left, right) => left.columnIndex - right.columnIndex)) {
      const attribute = object.attributes.find((candidate) => candidate.attributeId === entry.fieldRef)
      if (attribute === undefined) {
        issues.push(issue('UNKNOWN_ATTRIBUTE', 'error', `attribute ${entry.fieldRef} is not declared on object ${object.objectId}`, {
          fieldRef: entry.fieldRef,
          columnIndex: entry.columnIndex,
          header: entry.header,
        }))
        continue
      }
      if (seenFields.has(entry.fieldRef)) {
        issues.push(issue('DUPLICATE_COLUMN', 'error', `attribute ${entry.fieldRef} is mapped more than once`, { fieldRef: entry.fieldRef }))
        continue
      }
      seenFields.add(entry.fieldRef)
      referencedHeaders.add(entry.header)

      const column = isRecords
        ? columns.find((candidate) => candidate.header === entry.header)
        : columns.find((candidate) => candidate.index === entry.columnIndex)
      if (column === undefined) {
        issues.push(
          issue(
            isRecords ? 'HEADER_MISMATCH' : 'COLUMN_INDEX_OUT_OF_RANGE',
            'error',
            `no source column matches ${isRecords ? `header ${entry.header}` : `index ${entry.columnIndex}`}`,
            { fieldRef: entry.fieldRef, columnIndex: entry.columnIndex, header: entry.header },
          ),
        )
        continue
      }
      if (column.header !== entry.header || column.headerDigest !== entry.headerDigest) {
        issues.push(issue('HEADER_MISMATCH', 'error', `the source header for column ${entry.columnIndex} does not match the confirmed header`, {
          fieldRef: entry.fieldRef,
          columnIndex: column.index,
          header: column.header,
        }))
        continue
      }

      const { normalization, unitIssues } = this.#unitNormalization(attribute, entry)
      issues.push(...unitIssues)

      const samples: MappingSample[] = []
      for (const row of rows.slice(0, SAMPLE_LIMIT)) {
        const cell = cellFor(row, entry, isRecords)
        const outcome = normalizeCell(attribute, entry, cell)
        samples.push({
          recordIndex: row.recordIndex,
          row: row.row,
          raw: outcome.raw,
          ...(outcome.canonical === undefined ? {} : { canonical: outcome.canonical }),
          locator: cell?.locator ?? { kind: 'approximate_locator' },
        })
      }
      previewColumns.push({
        fieldRef: entry.fieldRef,
        valueType: attribute.valueType,
        ...(attribute.unitCode === undefined ? {} : { canonicalUnitCode: attribute.unitCode }),
        ...(entry.sourceUnitCode === undefined ? {} : { sourceUnitCode: entry.sourceUnitCode }),
        normalization,
        columnIndex: column.index,
        header: column.header,
        samples,
      })
    }

    for (const attribute of object.attributes) {
      const required = attribute.identityKey === true || attribute.minCardinality > 0
      if (required && !seenFields.has(attribute.attributeId)) {
        issues.push(issue('MISSING_COLUMN', 'error', `required attribute ${attribute.attributeId} has no column correspondence`, {
          fieldRef: attribute.attributeId,
        }))
      }
    }

    const unmappedColumns: MappingUnmappedColumn[] = columns
      .filter((column) => !referencedHeaders.has(column.header))
      .map((column) => ({ columnIndex: column.index, header: column.header }))

    const confirmable =
      previewColumns.length > 0 &&
      rows.length > 0 &&
      !issues.some((entry) => entry.severity === 'error')

    return {
      projectId,
      definitionRef,
      objectId: object.objectId,
      format: request.format,
      parseId: request.parseId,
      columns: previewColumns,
      unmappedColumns,
      issues,
      rowCount: rows.length,
      confirmable,
    }
  }

  #unitNormalization(
    attribute: IndustryAttributeSchema,
    entry: ColumnMappingEntry,
  ): { readonly normalization: ColumnPreview['normalization']; readonly unitIssues: readonly MappingIssue[] } {
    if (attribute.valueType !== 'quantity') {
      if (entry.sourceUnitCode !== undefined || entry.canonicalUnitCode !== undefined) {
        return {
          normalization: 'identity',
          unitIssues: [issue('TYPE_MISMATCH', 'error', `attribute ${attribute.attributeId} is not a quantity and must not declare a unit`, { fieldRef: attribute.attributeId })],
        }
      }
      return { normalization: 'identity', unitIssues: [] }
    }
    const canonicalUnit = attribute.unitCode
    if (canonicalUnit === undefined) {
      return {
        normalization: 'unresolved',
        unitIssues: [issue('MISSING_UNIT', 'error', `quantity attribute ${attribute.attributeId} has no canonical unit`, { fieldRef: attribute.attributeId })],
      }
    }
    const source = entry.sourceUnitCode
    if (entry.canonicalUnitCode !== undefined && entry.canonicalUnitCode !== canonicalUnit) {
      return {
        normalization: 'unresolved',
        unitIssues: [issue('UNIT_MISMATCH', 'error', `declared canonical unit ${entry.canonicalUnitCode} differs from the attribute canonical unit ${canonicalUnit}`, { fieldRef: attribute.attributeId })],
      }
    }
    if (source === undefined) {
      return {
        normalization: 'unresolved',
        unitIssues: [issue('MISSING_UNIT', 'warning', `attribute ${attribute.attributeId} declares no source unit`, { fieldRef: attribute.attributeId })],
      }
    }
    if (source === canonicalUnit) return { normalization: 'identity', unitIssues: [] }
    if (entry.unitConversion === undefined) {
      return {
        normalization: 'unresolved',
        unitIssues: [issue('MISSING_UNIT_CONVERSION', 'error', `source unit ${source} needs an exact conversion to ${canonicalUnit}`, { fieldRef: attribute.attributeId })],
      }
    }
    if (!conversionIsWellFormed(entry.unitConversion, source, canonicalUnit)) {
      return {
        normalization: 'unresolved',
        unitIssues: [issue('UNIT_MISMATCH', 'error', `the declared conversion does not translate ${source} to ${canonicalUnit}`, { fieldRef: attribute.attributeId })],
      }
    }
    return { normalization: 'exact', unitIssues: [] }
  }
}

function nextVersion(current: Semver | undefined): Semver {
  if (current === undefined) return '1.0.0'
  const parts = current.split('.')
  const major = Number.parseInt(parts[0] ?? '1', 10)
  const minor = Number.parseInt(parts[1] ?? '0', 10)
  const patch = Number.parseInt(parts[2] ?? '0', 10)
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return '1.0.0'
  return `${major}.${minor + 1}.${patch}`
}
