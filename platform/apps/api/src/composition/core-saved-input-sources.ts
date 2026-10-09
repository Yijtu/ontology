import { assertProjectDatasetFieldSourcesShape, isComputeOutputBindings, isComputeResultArtifact, isRecord, isResourceRef, isRevisionString, isUuid, sha256OfCanonical } from '@ontology/contracts'
import type { ArchivedRunExecutionBinding, CandidateStore, ComputeOutputBindingsStore, ComputeResultArtifactStore, DocumentParseStore, InstanceReviewStore, ProjectDatasetFieldSource, ProjectDatasetQueryPort, ProjectMappingStore, ProjectRevision, ProjectSnapshotQueryPort, ResourceRef, ScopeRef, SemanticPublicationStore, TaskBindingStore, TaskInputSnapshotStore, ToolContext } from '@ontology/contracts'
import type { CoreSourceFragment } from './core-source-view'
import type { RequestNativeSourceReader } from './core-native-source-reader'
import type { SavedCellRead } from './core-saved-cell-reader'
import { savedPointer } from './core-saved-cell-reader'
import { canonicalDecimal, canonicalJson, sha256DigestOf } from '@ontology/application'

export interface SavedInputSourcePorts {
  readonly datasets?: Pick<ProjectSnapshotQueryPort, 'describeSnapshot'> & Pick<ProjectDatasetQueryPort, 'getActivation'>
  readonly publications?: Pick<SemanticPublicationStore, 'getReview' | 'getStatementRevision' | 'getStatement' | 'getPublication'>
  readonly computeResults?: Pick<ComputeResultArtifactStore, 'getArtifact'>
  readonly computeBindings?: Pick<ComputeOutputBindingsStore, 'getBindings'>
  readonly tasks?: Pick<TaskBindingStore, 'getBinding'>
  readonly taskInputs?: Pick<TaskInputSnapshotStore, 'getSnapshot'>
}
export interface SourceReadCoverage {
  readonly mode: 'saved_cell' | 'query_result_sample' | 'compute_input_artifacts' | 'compute_input_sample' | 'unsupported'
  readonly requested: number
  readonly verified: number
  readonly displayed: number
  readonly knownTotal: number | null
  readonly truncated: boolean
  readonly coverage: 'complete' | 'partial' | 'unsupported'
  readonly maxRows: 10
  readonly maxFragments: 10
}
export interface SavedInputArtifactView {
  readonly ref: ResourceRef
  readonly inputRefPointers: readonly string[]
  readonly byteSize: number
  readonly text?: string
  readonly textTruncated: boolean
}
export interface SavedInputSources {
  readonly sourceCoverage: SourceReadCoverage
  readonly sourceReadLimitation?: string
  readonly fragments?: readonly CoreSourceFragment[]
  readonly inputArtifacts?: readonly SavedInputArtifactView[]
}
const equal = (left: unknown, right: unknown) => sha256OfCanonical(left) === sha256OfCanonical(right)
// These producers serialize binary-key canonical JSON. Typed-table receipts
// deliberately retain their separate contracts canonicalizer.
const producerDigest = (value: unknown) => sha256DigestOf(canonicalJson(value))
function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw Object.assign(new Error(message), { code: 'SOURCE_UNVERIFIABLE', httpStatus: 409 })
}
const count = (value: unknown, max = 20_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const unsupported = (message: string, requested = 0): SavedInputSources => ({ sourceReadLimitation: message, sourceCoverage: { mode: 'unsupported', requested, verified: 0, displayed: 0, knownTotal: null, truncated: true, coverage: 'unsupported', maxRows: 10, maxFragments: 10 } })
interface SavedRow { readonly recordId: string; readonly objectId: string; readonly sourceRowKey: string; readonly values: Readonly<Record<string, unknown>>; readonly sources: readonly ProjectDatasetFieldSource[] }
function savedRow(value: unknown): SavedRow {
  requireInput(isRecord(value) && isUuid(value['recordId']) && typeof value['objectId'] === 'string' && typeof value['sourceRowKey'] === 'string' && isRecord(value['values']), 'a captured input row has malformed identity/values')
  try { assertProjectDatasetFieldSourcesShape(value['sources']) } catch { requireInput(false, 'a captured input row has malformed original-source pins') }
  const sources = value['sources']
  requireInput(Array.isArray(sources) && sources.length > 0 && sources.length <= 128, 'a captured input row has no bounded field origins')
  return { recordId: value['recordId'], objectId: value['objectId'], sourceRowKey: value['sourceRowKey'], values: value['values'], sources }
}

/** Saved query identities and captured approval acts are authority; mutable current records are never read. */
interface SavedInputRead {
  readonly ports: SavedInputSourcePorts
  readonly candidates: Pick<CandidateStore, 'getCandidate'>
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly parses: Pick<DocumentParseStore, 'getParse'>
  readonly confirmations: Pick<InstanceReviewStore, 'listConfirmations'>
  readonly scope: ScopeRef
  readonly ctx: ToolContext
  readonly archived: ArchivedRunExecutionBinding
  readonly revision: ProjectRevision
  readonly payload: Readonly<Record<string, unknown>>
  readonly cell?: SavedCellRead
  readonly native: RequestNativeSourceReader
  readonly readJson: (ref: ResourceRef, cap: number) => Promise<unknown>
  readonly readBytes: (ref: ResourceRef, cap: number) => Promise<Uint8Array>
  readonly check: () => void
}

export async function readSavedInputSources(input: SavedInputRead): Promise<SavedInputSources> {
  // Archive pagination must not turn one bounded source read into an unbounded
  // inventory scan. The byte port applies this remaining cap before reading bodies.
  let remaining = 64 * 1_048_576
  const bounded: SavedInputRead = { ...input, readJson: async (ref, cap) => {
    input.check()
    const limit = Math.min(cap, remaining)
    requireInput(limit > 0, 'the captured source archive exceeds its 64-MiB request budget')
    const bytes = await input.readBytes(ref, limit)
    requireInput(bytes.byteLength <= limit, 'the captured source body exceeds its remaining request budget')
    remaining -= bytes.byteLength
    input.check()
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    catch { requireInput(false, 'the captured source JSON is malformed') }
  } }
  return readSavedInputSourcesWithinBudget(bounded)
}

async function readSavedInputSourcesWithinBudget(input: SavedInputRead): Promise<SavedInputSources> {
  const { archived, payload, cell } = input
  const execution = archived.binding
  const fixedInputRef = execution.request.inputSnapshotRef
  input.check()
  if (isRecord(payload['computation'])) {
    if (input.ports.computeResults === undefined || input.ports.computeBindings === undefined || input.ports.tasks === undefined) return unsupported('固定计算输入读取尚未配置。', cell === undefined ? 0 : 1)
    const computation = payload['computation']
    requireInput(isResourceRef(computation['resultRef']), 'the saved computation has no exact result wrapper reference')
    const stored = await input.ports.computeResults.getArtifact(input.scope, computation['resultRef'], input.ctx)
    requireInput(stored !== undefined && equal(stored.ref, computation['resultRef']) && isComputeResultArtifact(stored.artifact) && producerDigest(stored.artifact) === stored.ref.digest, 'the actual computation wrapper failed its complete stored body hash')
    const artifact = stored.artifact
    requireInput(equal(artifact.inputSnapshotRef, fixedInputRef) && artifact.inputSnapshotDigest === fixedInputRef.digest && equal(artifact.operationRef, computation['operationRef']) && equal(artifact.algorithmVersion, computation['algorithmVersion']) && execution.allowedTaskBindingRefs.some((ref) => equal(ref, artifact.taskBindingRef)) && (execution.request.mode !== 'task' || equal(execution.request.taskBindingRef, artifact.taskBindingRef)), 'the saved computation has different input/operation/task pins')
    const task = await input.ports.tasks.getBinding(input.scope, artifact.taskBindingRef, input.ctx)
    requireInput(task !== undefined && equal(task.taskBindingRef, artifact.taskBindingRef) && task.kind === 'compute' && equal(task.actionDefinitionRef, input.revision.definitionRef) && equal(task.operationRef, artifact.operationRef) && task.registeredOperationDigest === artifact.registeredOperationDigest, 'the stored compute task does not pin this actual definition/operation body')
    const { taskBindingRef, ...taskBody } = task
    requireInput(producerDigest({ ...taskBody, taskBindingIdentity: { id: taskBindingRef.id, version: taskBindingRef.version } }) === taskBindingRef.digest && producerDigest(task.parameterSchema) === task.parameterSchemaDigest, 'the actual published task failed its canonical declaration/parameter schema hash')
    const parameters = await input.readJson(artifact.parametersRef, 1_048_576)
    requireInput(artifact.parametersRef.digest === artifact.parametersDigest && (execution.request.mode !== 'task' || equal(parameters, execution.request.parameters)), 'the actual archived compute parameters differ from the saved task request')
    const storedBindings = await input.ports.computeBindings.getBindings(input.scope, artifact.outputBindingsRef, input.ctx)
    requireInput(storedBindings !== undefined && equal(storedBindings.ref, artifact.outputBindingsRef) && isComputeOutputBindings(storedBindings.bindings) && producerDigest(storedBindings.bindings) === storedBindings.ref.digest, 'the actual stored compute output bindings failed their complete hash')
    const bindings = storedBindings.bindings
    requireInput(equal(bindings.inputRefs, artifact.inputRefs) && equal(bindings.outputArtifactRef, artifact.outputArtifactRef) && bindings.outputDigest === artifact.outputDigest && bindings.outputSchemaRef.digest === artifact.outputSchemaDigest && bindings.parametersDigest === artifact.parametersDigest && equal(bindings.coverage, artifact.coverage) && bindings.domainStatus === artifact.domainStatus && bindings.dataMode === artifact.dataMode, 'the actual compute artifact/output schema/input bindings disagree')
    const output = await input.readJson(artifact.outputArtifactRef, 8 * 1_048_576)
    requireInput(isRecord(output) && equal(output['operationRef'], artifact.operationRef) && isRecord(output['metrics']) && equal(output['metrics'], computation['metrics']), 'the saved computation metrics differ from the actual archived operation output')
    requireInput(artifact.outputArtifactRef.digest === artifact.outputDigest && artifact.inputRefs.length > 0 && artifact.inputRefs.length <= 10 && artifact.inputRefs.every((ref) => equal(ref, fixedInputRef)), 'the normal computation input scope differs from its fixed run input')
    const fields = cell === undefined ? bindings.fields : bindings.fields.filter((field) => field.rowKey === cell.selector.rowKey && field.columnRef === cell.selector.columnRef)
    requireInput(fields.length > 0 && fields.length <= 128 && (cell === undefined || fields.length === 1) && fields.every((field) => field.inputRefPointers.length > 0 && field.inputRefPointers.length <= 10), 'the selected computation field has no unique exact finite input binding')
    if (cell !== undefined) {
      const field = fields[0]!
      const computedValue = savedPointer(output, field.valuePointer)
      const savedValue = savedPointer(payload, cell.binding.valuePointer)
      const amount = (value: unknown) => isRecord(value) && 'value' in value ? value['value'] : isRecord(value) && 'amount' in value ? value['amount'] : value
      const actualAmount = amount(computedValue), savedAmount = amount(savedValue), displayedAmount = amount(cell.value)
      // A registered count can be a safe integer. Decimal data stays in strings;
      // floating numbers never become exact source authority through coercion.
      const exact = (value: unknown) => typeof value === 'string' ? canonicalDecimal(value) : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined
      requireInput(computedValue !== undefined && exact(actualAmount) !== undefined && exact(savedAmount) === exact(actualAmount) && exact(displayedAmount) === exact(actualAmount), 'the selected saved compute cell differs from its exact archived output binding')
      requireInput(field.unit === undefined || cell.binding.unitPointer !== undefined && savedPointer(payload, cell.binding.unitPointer) === field.unit, 'the selected compute cell has a different archived unit')
      requireInput(field.currency === undefined || cell.binding.currencyPointer !== undefined && savedPointer(payload, cell.binding.currencyPointer) === field.currency, 'the selected compute cell has a different archived currency')
      requireInput(!isRecord(cell.value) || (cell.value['unit'] === undefined || cell.value['unit'] === field.unit) && (cell.value['currency'] === undefined || cell.value['currency'] === field.currency), 'the selected compute cell display has a different unit/currency')
    }
    const selected = new Map<string, { ref: ResourceRef; pointers: string[] }>()
    for (const field of fields) for (const pointer of field.inputRefPointers) {
      requireInput(/^\/inputRefs\/(?:0|[1-9][0-9]*)$/u.test(pointer), 'the compute input binding is not a declared whole-input reference')
      const ref = savedPointer(artifact, pointer)
      requireInput(isResourceRef(ref) && artifact.inputRefs.some((candidate) => equal(candidate, ref)), 'the actual compute input pointer is outside the archived wrapper')
      const key = sha256OfCanonical(ref), prior = selected.get(key)
      if (prior === undefined) selected.set(key, { ref, pointers: [pointer] })
      else if (!prior.pointers.includes(pointer)) prior.pointers.push(pointer)
    }
    const inputs: SavedInputArtifactView[] = []
    for (const selectedInput of selected.values()) {
      const bytes = await input.readBytes(selectedInput.ref, 8 * 1_048_576)
      let text: string | undefined
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Binary input remains a verified exact ref, never fabricated text. */ }
      // Streaming decode leaves an incomplete final UTF-8 code point buffered.
      // This bounds the displayed prefix without repeatedly encoding long text.
      const shown = text === undefined ? undefined : bytes.byteLength <= 16_384 ? text : new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 16_384), { stream: true })
      inputs.push({ ref: selectedInput.ref, inputRefPointers: selectedInput.pointers, byteSize: bytes.byteLength, ...(shown === undefined ? {} : { text: shown }), textTruncated: shown === undefined || shown !== text })
    }
    const recheck = async () => {
      input.check()
      requireInput(equal(await input.ports.computeResults?.getArtifact(input.scope, stored.ref, input.ctx), stored) && equal(await input.ports.computeBindings?.getBindings(input.scope, storedBindings.ref, input.ctx), storedBindings) && equal(await input.ports.tasks?.getBinding(input.scope, artifact.taskBindingRef, input.ctx), task), 'the saved compute wrapper/input bindings/task changed during source read')
      input.check()
    }
    await recheck()
    const metadata = await input.ports.taskInputs?.getSnapshot(input.scope, fixedInputRef, input.ctx)
    if (metadata?.body.producedBy === 'core-approved-project-compute-input@1') {
      requireInput(equal(metadata.ref, fixedInputRef) && equal(metadata.body.projectRevisionRef, input.revision.ref) && metadata.body.projectId === input.revision.ref.projectId && metadata.body.baseInputDigest === metadata.body.baseInputRef.digest && metadata.body.dependencies.length >= 3 && metadata.body.dependencies.length <= 203, 'the actual derived-input metadata has different base/project/schema pins')
      // This registered producer appends exactly one immutable selection ref after
      // its base/page dependencies. The full dependency list is checked below.
      const selectionRef = metadata.body.dependencies.at(-1)
      requireInput(selectionRef !== undefined, 'the derived input has no captured source selection')
      const sourceSelection = await input.readJson(selectionRef, 8 * 1_048_576)
      const base = await input.readJson(metadata.body.baseInputRef, 8 * 1_048_576)
      requireInput(isRecord(sourceSelection) && sourceSelection['schemaVersion'] === 'core-compute-input-selection@1' && equal(sourceSelection['projectRevisionRef'], input.revision.ref) && equal(sourceSelection['baseInputRef'], metadata.body.baseInputRef) && equal(sourceSelection['inputRef'], fixedInputRef) && equal(sourceSelection['taskBindingRef'], artifact.taskBindingRef) && equal(sourceSelection['operationRef'], artifact.operationRef) && sourceSelection['registeredOperationDigest'] === artifact.registeredOperationDigest && sourceSelection['parameterSchemaDigest'] === artifact.inputSchemaDigest && isResourceRef(sourceSelection['dataSchemaRef']) && sourceSelection['dataSchemaRef'].kind === 'artifact' && isRecord(sourceSelection['selection']) && Array.isArray(sourceSelection['records']) && sourceSelection['records'].length > 0 && sourceSelection['records'].length <= 20_000, 'the actual immutable compute selection is detached from its derived bytes/operation/task')
      const dataSchemaRef = sourceSelection['dataSchemaRef']
      requireInput(equal(metadata.body.inputSchemaRef, { id: dataSchemaRef.id, version: dataSchemaRef.version, digest: dataSchemaRef.digest }), 'the derived-input data schema was confused with invocation parameters')
      const actualDataSchema = await input.readJson(dataSchemaRef, 1_048_576)
      requireInput(isRecord(actualDataSchema) && producerDigest(actualDataSchema) === dataSchemaRef.digest, 'the real archived compute data schema failed its full body hash')
      requireInput(isRecord(base) && base['schemaVersion'] === 'project-input-snapshot@1' && Array.isArray(base['recordPages']) && base['recordPages'].length <= 200, 'the actual compute base is not an approved-input archive')
      const pages = base['recordPages'].map((page: unknown) => { requireInput(isRecord(page) && isResourceRef(page['ref']), 'a compute base page reference is malformed'); return page['ref'] })
      requireInput(equal(metadata.body.dependencies, [metadata.body.baseInputRef, ...pages, dataSchemaRef, selectionRef]), 'the actual compute dependency set differs from its approved base pages, data schema and source selection')
      const selection = sourceSelection['selection']
      requireInput(Object.keys(selection).every((key) => ['objectId', 'idField', 'amountField', 'unitField', 'currencyField'].includes(key)) && ['objectId', 'idField', 'amountField'].every((key) => typeof selection[key] === 'string' && selection[key].length > 0 && selection[key].length <= 256) && ['unitField', 'currencyField'].every((key) => selection[key] === undefined || typeof selection[key] === 'string' && selection[key].length > 0 && selection[key].length <= 256), 'the captured compute field selection is outside its closed declaration')
      const objectId = selection['objectId'], idField = selection['idField'], amountField = selection['amountField']
      requireInput(typeof objectId === 'string' && typeof idField === 'string' && typeof amountField === 'string', 'the captured compute source fields are malformed')
      const derived = await input.readJson(fixedInputRef, 8 * 1_048_576)
      requireInput(isRecord(derived) && Array.isArray(derived['rows']) && derived['rows'].length === sourceSelection['records'].length, 'the actual derived rows differ from the complete saved original selection')
      const derivedRows = derived['rows']
      const fieldIds = [...new Set([idField, amountField, ...typeof selection['unitField'] === 'string' ? [selection['unitField']] : [], ...typeof selection['currencyField'] === 'string' ? [selection['currencyField']] : []])]
      const seen = new Set<string>()
      const all: OriginChoice[] = sourceSelection['records'].map((record: unknown, index): OriginChoice => {
        requireInput(isRecord(record) && isUuid(record['recordId']) && !seen.has(record['recordId']), 'the actual computation source record is malformed or duplicated')
        seen.add(record['recordId'])
        const sources = record['sources']
        try { assertProjectDatasetFieldSourcesShape(sources) } catch { requireInput(false, 'the captured compute sources are malformed') }
        requireInput(fieldIds.every((field) => sources.filter((source) => source.fieldId === field).length === 1) && sources.every((source) => fieldIds.includes(source.fieldId)), 'the compute source selection omits or adds an unselected original field')
        const row = derivedRows[index]
        requireInput(isRecord(row) && typeof row['id'] === 'string' && typeof row['amount'] === 'string', 'the actual derived computation row is malformed')
        return { recordId: record['recordId'], sources, fields: fieldIds, completeSources: false, checkField: (captured, fieldId) => {
          const value = captured.values[fieldId]
          requireInput(isRecord(value) && ['scalar', 'quantity'].includes(String(value['kind'])), 'the selected computation field has no canonical approved value')
          if (fieldId === amountField) requireInput(typeof value['value'] === 'string' && typeof row['amount'] === 'string' && canonicalDecimal(row['amount']) !== undefined && canonicalDecimal(row['amount']) === canonicalDecimal(value['value']) && (value['kind'] !== 'quantity' || row['unit'] === value['unitCode']), 'the actual derived amount/unit differs from the approved exact quantity')
          else requireInput(value['kind'] === 'scalar' && typeof value['value'] === 'string' && (fieldId !== idField || value['value'] === row['id']) && (fieldId !== selection['unitField'] || value['value'] === row['unit']) && (fieldId !== selection['currencyField'] || value['value'] === row['currency']), 'the actual derived identifier/unit/currency differs from its approved field')
        } }
      })
      const originals = await readApprovedOrigins(input, { baseRef: metadata.body.baseInputRef, objectId, choices: all.slice(0, 10), knownTotal: all.length, mode: 'compute_input_sample' })
      requireInput(equal(await input.ports.taskInputs?.getSnapshot(input.scope, fixedInputRef, input.ctx), metadata), 'the captured derived-input metadata changed during original source reads')
      await recheck()
      return { ...originals, inputArtifacts: inputs, sourceReadLimitation: `该计算字段使用这里固定的输入范围；原始输入来源为有界展示，最多10行/10个片段，不表示聚合输出与某一个原始单元格一一对应。已展示${originals.sourceCoverage.displayed}行，共${all.length}行。` }
    }
    await recheck()
    return { inputArtifacts: inputs, sourceReadLimitation: '已核对该计算字段的固定输入工件；这个历史输入尚无可重放的原始表格单元格链。聚合结果对应这些输入范围，不能解释为与单个原始单元格一一对应。', sourceCoverage: { mode: 'compute_input_artifacts', requested: selected.size, verified: inputs.length, displayed: inputs.length, knownTotal: selected.size, truncated: inputs.some((view) => view.textTruncated), coverage: inputs.some((view) => view.textTruncated) ? 'partial' : 'complete', maxRows: 10, maxFragments: 10 } }
  }
  const table = payload['table']
  if (!isRecord(table) || !Array.isArray(table['columns']) || !Array.isArray(table['rows'])) return unsupported('本次保存的结果未登记可回读的原始字段对应关系。', cell === undefined ? 0 : 1)
  const columns = table['columns']
  requireInput(columns.length <= 128 && table['rows'].length <= 10_000 && table['rows'].every((row: unknown) => Array.isArray(row) && row.length === columns.length), 'the saved query table exceeds its finite source-read contract')
  const recordIndex = columns.findIndex((column: unknown) => isRecord(column) && column['name'] === 'record_id')
  const sourcesIndex = columns.findIndex((column: unknown) => isRecord(column) && column['name'] === 'sources_json')
  if (recordIndex < 0 || sourcesIndex < 0) return unsupported('该结果没有保存逐行原始来源标识，不能从值或行号推断原始单元格。', cell === undefined ? Math.min(10, table['rows'].length) : 1)
  const metadataRef = execution.projectDatasetSnapshotRef
  if (metadataRef === undefined || input.ports.datasets === undefined || input.ports.publications === undefined) return unsupported('固定数据快照与历史批准记录读取尚未配置。', cell === undefined ? Math.min(10, table['rows'].length) : 1)
  const descriptor = await input.ports.datasets.describeSnapshot(input.scope, metadataRef, input.ctx)
  const activation = await input.ports.datasets.getActivation(input.scope, metadataRef, input.ctx)
  requireInput(descriptor?.metadata !== undefined && activation !== undefined && equal(descriptor.snapshotRef, metadataRef) && equal(descriptor.metadata.scopeRef, input.scope) && equal(descriptor.metadata.snapshotRef, metadataRef) && equal(descriptor.metadata.body.projectRevisionRef, input.revision.ref) && equal(descriptor.metadata.body.definitionRef, input.revision.definitionRef) && equal(descriptor.metadata.activation, activation) && equal(activation.scopeRef, input.scope) && equal(activation.snapshotRef, metadataRef) && equal(activation.projectRevisionRef, input.revision.ref) && activation.objectId === descriptor.objectId && activation.sourceDigest === descriptor.metadata.body.sourceDigest && equal(activation.factRecordedPoint, descriptor.metadata.body.factRecordedPoint), 'the actual historical snapshot metadata/activation source pins differ from this saved run')
  const outputRows = table['rows']
  if (outputRows.length === 0) {
    requireInput(cell === undefined, 'an explicit saved cell cannot refer to an empty query result')
    return { sourceReadLimitation: '本次固定查询没有返回记录，因此没有结果行的原始来源。', sourceCoverage: { mode: 'query_result_sample', requested: 0, verified: 0, displayed: 0, knownTotal: 0, truncated: false, coverage: 'complete', maxRows: 10, maxFragments: 10 } }
  }
  let chosen: { values: unknown[]; fields: string[] }[]
  if (cell !== undefined) {
    const match = /^\/table\/rows\/(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u.exec(cell.binding.valuePointer)
    requireInput(match !== null, 'the saved cell does not bind one actual returned query row/column')
    const row = outputRows[Number(match[1])], column = columns[Number(match[2])]
    requireInput(Array.isArray(row) && isRecord(column) && typeof column['semanticFieldRef'] === 'string' && column['semanticFieldRef'] === cell.column.semanticPredicate && row[recordIndex] === cell.subject && savedPointer(payload, cell.binding.subjectPointer) === cell.subject && cell.binding.fieldRefPointer !== undefined && equal(savedPointer(payload, cell.binding.fieldRefPointer), column), 'the actual saved cell subject/field/pointers do not bind this query row')
    chosen = [{ values: row, fields: [column['semanticFieldRef']] }]
  } else chosen = outputRows.slice(0, 10).map((values: unknown[]) => ({ values, fields: columns.flatMap((column: unknown) => isRecord(column) && typeof column['semanticFieldRef'] === 'string' && !['record_id', 'sources_json'].includes(column['name'] as string) ? [column['semanticFieldRef']] : []) }))
  const choices: OriginChoice[] = chosen.map((selected) => {
    const recordId = selected.values[recordIndex]
    requireInput(isUuid(recordId), 'the saved query row has no actual record identity')
    let sources: unknown = selected.values[sourcesIndex]
    if (typeof sources === 'string') { try { sources = JSON.parse(sources) as unknown } catch { requireInput(false, 'the saved query source JSON is malformed') } }
    try { assertProjectDatasetFieldSourcesShape(sources) } catch { requireInput(false, 'the saved query sources are malformed') }
    return { recordId, sources, fields: selected.fields, completeSources: true, checkField: (row, fieldId) => {
      const found = columns.map((column: unknown, index) => ({ column, index })).filter(({ column }) => isRecord(column) && column['semanticFieldRef'] === fieldId)
      requireInput(found.length === 1 && found[0] !== undefined && isRecord(found[0].column), 'the saved query field descriptor is missing or ambiguous')
      const outputField = found[0], outputColumn = outputField.column
      requireInput(isRecord(outputColumn), 'the saved field descriptor is malformed')
      const captured = row.values[fieldId], declared = descriptor.columns.find((column) => column.name === fieldId)
      requireInput(isRecord(captured) && (captured['kind'] === 'scalar' || captured['kind'] === 'quantity') && declared !== undefined, 'the exact approved snapshot has no declared canonical query value')
      const matches = (value: unknown): boolean => {
        if (declared.valueType === 'number' || declared.valueType === 'quantity') {
          const raw = isRecord(value) && 'value' in value ? value['value'] : value
          return typeof raw === 'string' && typeof captured['value'] === 'string' && canonicalDecimal(raw) !== undefined && canonicalDecimal(raw) === canonicalDecimal(captured['value'])
        }
        return equal(value, captured['value'])
      }
      requireInput(matches(selected.values[outputField.index]) && (cell === undefined || matches(cell.value)), 'the selected saved result value differs from the actual frozen canonical field')
      if (captured['kind'] === 'quantity') requireInput(captured['unitCode'] === outputColumn['unit'] && captured['unitCode'] === declared.canonicalUnitCode && (cell === undefined || cell.binding.unitPointer !== undefined && savedPointer(payload, cell.binding.unitPointer) === captured['unitCode'] && (!isRecord(cell.value) || cell.value['unit'] === undefined || cell.value['unit'] === captured['unitCode'])), 'the saved quantity unit differs from the frozen input/schema unit')
    } }
  })
  return readApprovedOrigins(input, { baseRef: fixedInputRef, objectId: descriptor.objectId, choices, knownTotal: cell === undefined ? outputRows.length : 1, mode: cell === undefined ? 'query_result_sample' : 'saved_cell', sourcePoint: { sourceDigest: activation.sourceDigest, factRecordedPoint: activation.factRecordedPoint, snapshotRef: metadataRef }, after: async () => {
    requireInput(equal(await input.ports.datasets?.describeSnapshot(input.scope, metadataRef, input.ctx), descriptor) && equal(await input.ports.datasets?.getActivation(input.scope, metadataRef, input.ctx), activation), 'the historical snapshot metadata/activation changed during original reads')
  } })
}

interface OriginChoice {
  readonly recordId: string
  readonly sources: readonly ProjectDatasetFieldSource[]
  readonly fields: readonly string[]
  readonly completeSources: boolean
  readonly checkField: (row: SavedRow, fieldId: string) => void
}
interface OriginSelection {
  readonly baseRef: ResourceRef
  readonly objectId: string
  readonly choices: readonly OriginChoice[]
  readonly knownTotal: number
  readonly mode: 'saved_cell' | 'query_result_sample' | 'compute_input_sample'
  readonly sourcePoint?: { readonly sourceDigest: string; readonly factRecordedPoint: unknown; readonly snapshotRef: ResourceRef }
  readonly after?: () => Promise<void>
}
async function readApprovedOrigins(input: SavedInputRead, origin: OriginSelection): Promise<SavedInputSources> {
  const { choices: chosen } = origin
  requireInput(input.ports.publications !== undefined, 'actual historical publication/review readers are required')
  const outer = await input.readJson(origin.baseRef, 8 * 1_048_576)
  if (!isRecord(outer) || outer['schemaVersion'] !== 'project-input-snapshot@1') return unsupported('这个历史输入没有保存已批准记录与原始字段归档，无法补造逐格来源。', chosen.length)
  requireInput(outer['projectId'] === input.revision.ref.projectId && outer['inputRevision'] === input.revision.ref.revision && equal(outer['definitionRef'], input.revision.definitionRef) && equal(outer['mappingRefs'], input.revision.mappingRefs) && Array.isArray(outer['recordPages']) && outer['recordPages'].length <= 200 && isRecord(outer['counts']) && count(outer['counts']['approved']) && count(outer['counts']['confirmed']) && count(outer['counts']['total']) && outer['counts']['pending'] === 0 && outer['counts']['failed'] === 0 && outer['coverage'] === 'complete' && isResourceRef(outer['confirmationManifestRef']), 'the exact approved-input body has malformed or foreign immutable pins')
  const manifest = await input.readJson(outer['confirmationManifestRef'], 8 * 1_048_576)
  requireInput(isRecord(manifest) && manifest['schemaVersion'] === 'project-input-confirmations@1', 'the actual captured approval manifest is unavailable')
  const normal = isRecord(manifest['semanticPins']) ? manifest['semanticPins'] : undefined
  const pagedNormal = normal !== undefined && manifest['normalArchiveVersion'] === 'paged@1'
  const snapshots = manifest['snapshots']
  if (normal !== undefined) {
    requireInput(equal(normal['revision'], input.revision) && Array.isArray(normal['sources']) && normal['sources'].filter((source: unknown) => isRecord(source) && source['objectId'] === origin.objectId && (origin.sourcePoint === undefined || source['sourceDigest'] === origin.sourcePoint.sourceDigest && equal(source['factRecordedPoint'], origin.sourcePoint.factRecordedPoint))).length === 1, 'the actual normal-input semantic capture does not match its fixed dataset')
    if (pagedNormal) requireInput(equal(manifest['projectRevisionRef'], input.revision.ref) && equal(manifest['recordPages'], outer['recordPages']) && Array.isArray(manifest['physicalPages']) && manifest['physicalPages'].length <= 200 && Array.isArray(manifest['confirmationPages']) && manifest['confirmationPages'].length <= 200 && !['physical', 'rows', 'human'].some((key) => key in normal), 'the actual paged normal capture has different record-page closure or headers')
    else requireInput(manifest['normalArchiveVersion'] === undefined && Array.isArray(manifest['human']), 'the captured normal archive version is unsupported')
  } else requireInput(equal(manifest['projectRevisionRef'], input.revision.ref) && Array.isArray(snapshots) && snapshots.some((snapshot: unknown) => isRecord(snapshot) && snapshot['objectId'] === origin.objectId && (origin.sourcePoint === undefined || equal(snapshot['snapshotRef'], origin.sourcePoint.snapshotRef) && snapshot['sourceDigest'] === origin.sourcePoint.sourceDigest && equal(snapshot['factRecordedPoint'], origin.sourcePoint.factRecordedPoint))) && Array.isArray(manifest['confirmationPages']) && manifest['confirmationPages'].length <= 200, 'the actual evolved-input snapshot/approval capture does not match its fixed dataset')
  const pages = outer['recordPages']
  let accounted = 0, previous = ''
  for (const page of pages) {
    requireInput(isRecord(page) && isResourceRef(page['ref']) && count(page['rowCount'], 100) && page['rowCount'] > 0 && isUuid(page['firstRecordId']) && isUuid(page['lastRecordId']) && page['firstRecordId'] <= page['lastRecordId'] && (previous === '' || page['firstRecordId'] > previous), 'the actual approved input page descriptors are malformed or overlap')
    accounted += page['rowCount']; previous = page['lastRecordId']
  }
  requireInput(accounted === outer['counts']['approved'] && accounted === outer['counts']['confirmed'], 'the immutable approved record-page accounting differs')
  const humanRows: unknown[] = []
  if (normal !== undefined && !pagedNormal) humanRows.push(...manifest['human'] as unknown[])
  else for (const ref of manifest['confirmationPages'] as unknown[]) {
    requireInput(isResourceRef(ref), 'an evolved confirmation-page ref is malformed')
    const page = await input.readJson(ref, 8 * 1_048_576)
    requireInput(isRecord(page) && page['schemaVersion'] === 'project-input-confirmations-page@1' && equal(page['projectRevisionRef'], input.revision.ref) && Array.isArray(page['confirmations']) && page['confirmations'].length <= 100, 'the archived human page has different project/source pins')
    humanRows.push(...page['confirmations'])
  }
  requireInput(humanRows.length <= 20_000, 'the actual captured human inventory exceeds its finite bound')
  const humans = new Map<string, Record<string, unknown>>()
  for (const human of humanRows) { requireInput(isRecord(human) && isUuid(human['candidateId']) && !humans.has(human['candidateId']), 'the captured human candidate identity is malformed or ambiguous'); humans.set(human['candidateId'], human) }
  const pageCache = new Map<string, readonly SavedRow[]>()
  if (pagedNormal && normal !== undefined) {
    const physical: unknown[] = [], rows: SavedRow[] = []
    for (const ref of manifest['physicalPages'] as unknown[]) {
      requireInput(isResourceRef(ref), 'an archived physical page ref is malformed')
      const page = await input.readJson(ref, 8 * 1_048_576)
      requireInput(isRecord(page) && page['schemaVersion'] === 'project-input-physical-page@1' && equal(page['projectRevisionRef'], input.revision.ref) && Array.isArray(page['records']) && page['records'].length <= 100, 'an actual captured physical page is malformed or foreign')
      physical.push(...page['records'])
    }
    for (const pin of pages) {
      requireInput(isRecord(pin) && isResourceRef(pin['ref']), 'a captured normal page pin is malformed')
      const page = await input.readJson(pin['ref'], 8 * 1_048_576)
      requireInput(isRecord(page) && page['schemaVersion'] === 'project-input-record-page@1' && equal(page['projectRevisionRef'], input.revision.ref) && equal(page['definitionRef'], input.revision.definitionRef) && Array.isArray(page['records']) && page['records'].length === pin['rowCount'], 'the actual normal record page is detached from its input')
      const captured = page['records'].map(savedRow)
      requireInput(captured[0]?.recordId === pin['firstRecordId'] && captured.at(-1)?.recordId === pin['lastRecordId'], 'the actual normal record page boundary differs')
      pageCache.set(sha256OfCanonical(pin['ref']), captured)
      rows.push(...captured)
    }
    requireInput(physical.length <= 20_000 && rows.length <= 20_000 && rows.length === accounted, 'the actual paged source inventory exceeds its complete bound')
    const fullCapture = { ...normal, physical, rows, human: humanRows.map((row) => {
      requireInput(isRecord(row) && isRecord(row['review']), 'the actual paged human review is malformed')
      const { review, ...body } = row
      requireInput(isRecord(review), 'the captured human review is malformed')
      return { ...body, review: { candidateId: row['candidateId'], contentDigest: review['contentDigest'], decision: review['decision'] } }
    }) }
    requireInput(producerDigest(fullCapture) === manifest['semanticPinsDigest'], 'the paged normal capture failed its complete producer fingerprint')
  }
  const fences = new Map<string, () => Promise<void>>()
  const fragments: CoreSourceFragment[] = []
  let verified = 0, displayed = 0
  for (const selected of chosen) {
    input.check()
    const recordId = selected.recordId
    requireInput(selected.fields.length > 0, 'the captured input selection has no fields')
    const matching = pages.filter((page: unknown) => isRecord(page) && typeof page['firstRecordId'] === 'string' && typeof page['lastRecordId'] === 'string' && recordId >= page['firstRecordId'] && recordId <= page['lastRecordId'])
    requireInput(matching.length === 1 && isRecord(matching[0]) && isResourceRef(matching[0]['ref']), 'this returned record is not uniquely in the immutable approved input')
    const pagePin = matching[0]
    const pageRef = pagePin['ref']
    requireInput(isResourceRef(pageRef), 'the selected approved page reference is malformed')
    let archivedRows = pageCache.get(sha256OfCanonical(pageRef))
    if (archivedRows === undefined) {
      const page = await input.readJson(pageRef, 8 * 1_048_576)
      requireInput(isRecord(page) && page['schemaVersion'] === 'project-input-record-page@1' && equal(page['projectRevisionRef'], input.revision.ref) && equal(page['definitionRef'], input.revision.definitionRef) && Array.isArray(page['records']) && page['records'].length === pagePin['rowCount'] && (normal !== undefined || equal(page['snapshots'], snapshots)), 'the actual approved page differs from its saved project/definition/snapshot pins')
      archivedRows = page['records'].map(savedRow)
      requireInput(archivedRows[0]?.recordId === pagePin['firstRecordId'] && archivedRows.at(-1)?.recordId === pagePin['lastRecordId'], 'the actual approved page boundary differs')
      pageCache.set(sha256OfCanonical(pageRef), archivedRows)
    }
    const row = archivedRows.find((row) => row.recordId === recordId)
    requireInput(row !== undefined && row.objectId === origin.objectId && equal(selected.completeSources ? row.sources : row.sources.filter((source) => selected.fields.includes(source.fieldId)), selected.sources), 'the actual returned record/source JSON differs from the complete captured approved row')
    if (normal !== undefined && !pagedNormal) requireInput(Array.isArray(normal['rows']) && normal['rows'].some((saved: unknown) => equal(saved, row)), 'the approved page is detached from its actual captured semantic row')
    const groups = new Map<string, CoreSourceFragment>()
    for (const fieldId of selected.fields) {
      selected.checkField(row, fieldId)
      const origins = row.sources.filter((source) => source.fieldId === fieldId)
      requireInput(origins.length === 1 && origins[0] !== undefined, 'the saved query field has no unique captured original source')
      const source = origins[0], pin = source.factSource
      requireInput(pin !== undefined && source.statementId !== undefined && source.statementVersion !== undefined && source.rowDigest === pin.sourceDigest && source.parseId === pin.parseId && pin.projectRevisionRef.projectId === input.revision.ref.projectId, 'the approved field lacks its actual mapped candidate/source history pins')
      const human = humans.get(pin.entityCandidateId)
      requireInput(human !== undefined && isRecord(human['review']) && isRevisionString(human['review']['revision']) && human['review']['decision'] === 'approve' && human['review']['contentDigest'] === human['candidateDigest'], 'the captured field has no exact human approval act')
      const capturedReview = human['review'], capturedReviewRevision = capturedReview['revision']
      requireInput(isRevisionString(capturedReviewRevision), 'the captured approval revision is malformed')
      requireInput(equal(await input.ports.publications.getReview(input.scope, pin.entityCandidateId, human['review']['revision'], input.ctx), human['review']), 'the captured approval act does not match its real immutable ledger record')
      const instance = isRecord(human['instance']) ? human['instance'] : human
      const fields = instance['fields'], identity = instance['identity'], events = human['events'] ?? human['confirmationEvents']
      requireInput(Array.isArray(fields) && isRecord(identity) && ['matched', 'created'].includes(String(identity['state'])) && isRecord(identity['binding']) && identity['binding']['candidateId'] === pin.entityCandidateId && identity['binding']['documentId'] === pin.documentId && equal(identity['binding']['projectRevisionRef'], pin.projectRevisionRef) && equal(identity['binding']['definitionRef'], pin.definitionRef) && identity['binding']['membershipRevision'] === pin.membershipRevision && identity['binding']['visibilityEpoch'] === pin.visibilityEpoch && Array.isArray(events), 'the captured instance/identity does not bind this original source')
      const field = fields.find((field: unknown) => isRecord(field) && field['fieldId'] === fieldId)
      requireInput(isRecord(field) && field['status'] === 'confirmed' && typeof field['actor'] === 'string' && isRecord(field['source']) && equal(field['source']['documentRef'], source.documentRef) && field['source']['parseId'] === source.parseId && equal(field['source']['locator'], source.locator) && field['source']['textDigest'] === pin.sourceDigest && field['source']['quoteDigest'] === pin.sourceDigest, 'the captured human field does not have the exact confirmed original locator/hash')
      const event = events.find((event: unknown) => isRecord(event) && event['fieldId'] === fieldId && event['confirmationRevision'] === field['confirmationRevision'] && event['actor'] === field['actor'] && event['status'] === 'confirmed')
      requireInput(event !== undefined && (await input.confirmations.listConfirmations(input.scope, input.revision.ref.projectId, pin.entityCandidateId, input.ctx)).some((actual) => equal(actual, event)), 'the exact captured field confirmation act is unavailable')
      // The mutable row supplies only its immutable publication address. Its current
      // value/status/review never replaces or revokes the saved answer's old inputs.
      const address = await input.ports.publications.getStatement(input.scope, source.statementId, input.ctx)
      requireInput(address !== undefined && address.sourceCandidateId === pin.entityCandidateId, 'the historical statement publication address is unavailable')
      const publication = await input.ports.publications.getPublication(input.scope, address.publicationId, input.ctx)
      let statement = publication?.statements.find((row) => row.statementId === source.statementId && row.sourceCandidateId === pin.entityCandidateId)
      requireInput(statement !== undefined && statement.kind === 'entity' && /^[1-9][0-9]*$/u.test(source.statementVersion) && BigInt(source.statementVersion) <= 256n && BigInt(statement.version) <= BigInt(source.statementVersion), 'the actual original published statement revision is unavailable or exceeds its history bound')
      const statementRevisions: NonNullable<Awaited<ReturnType<SemanticPublicationStore['getStatementRevision']>>>[] = []
      for (let version = BigInt(statement.version) + 1n; version <= BigInt(source.statementVersion); version++) {
        const revision = await input.ports.publications.getStatementRevision(input.scope, source.statementId, String(version), input.ctx)
        requireInput(revision !== undefined && revision.statementId === source.statementId && revision.version === String(version), 'a captured original statement revision act is unavailable or foreign')
        statementRevisions.push(revision)
        statement = { ...statement, version: revision.version, status: revision.kind === 'retraction' ? 'retracted' : 'active', value: revision.correctedValue ?? statement.value }
      }
      requireInput(statement.version === source.statementVersion && statement.status === 'active' && statement.subjectEntityId === identity['matchedEntityId'], 'the captured statement did not represent this human-confirmed entity and active original input at its saved version')
      const candidate = await input.candidates.getCandidate(input.scope, pin.entityCandidateId, input.ctx)
      requireInput(candidate?.kind === 'entity' && candidate.objectId === row.objectId && candidate.idempotencyKey === human['candidateDigest'] && candidate.inputVersion.projectFact?.sources.some((saved) => equal(saved, pin)), 'the old immutable candidate body differs from its captured source/approval pins')
      const sourceBase = Object.fromEntries(Object.entries(pin).filter(([key]) => key !== 'entityCandidateId'))
      const fact = candidate.inputVersion.projectFact
      const valid = { ...(fact?.validFrom === undefined ? {} : { validFrom: fact.validFrom }), ...(fact?.validTo === undefined ? {} : { validTo: fact.validTo }) }
      requireInput(fact?.sources.length === 1 && producerDigest({ sourceBase, attributes: candidate.attributes, valid, objectId: candidate.objectId, identityScopeId: candidate.identityScopeId, jobId: candidate.jobId, parserVersion: candidate.inputVersion.parserVersion, pipelineVersion: candidate.inputVersion.pipelineVersion, sourceSpans: candidate.sourceSpans.map((span) => span.locator) }) === candidate.idempotencyKey, 'the original mapped candidate failed its actual producer content hash')
      const canonical = row.values[fieldId]
      const confirmedValue = field['normalizedValue']
      // Official datasets project an already-confirmed reference to its entity-id
      // scalar. Preserve that exact identity while comparing the two typed views.
      requireInput(isRecord(canonical) && (equal(confirmedValue, canonical) || isRecord(confirmedValue) && confirmedValue['kind'] === 'reference' && canonical['kind'] === 'scalar' && confirmedValue['entityId'] === canonical['value']), 'the canonical input value differs from the captured human-confirmed field')
      const attributes = statement.value['attributes']
      const published = Array.isArray(attributes) ? attributes.filter((attribute: unknown) => isRecord(attribute) && attribute['attributeId'] === fieldId) : []
      requireInput(published.length === 1 && isRecord(published[0]) && equal(published[0]['value'], canonical['value']) && (canonical['kind'] !== 'quantity' || published[0]['unitCode'] === canonical['unitCode']) && isRecord(statement.value['provenance']) && equal(statement.value['provenance']['sources'], fact.sources), 'the captured canonical field differs from its real historical publication value/source')
      const index = candidate.attributes.findIndex((attribute) => attribute.attributeId === fieldId), span = candidate.sourceSpans[index]
      requireInput(span?.kind === 'structured' && span.parseId === source.parseId && span.recordId === pin.recordId && span.rowDigest === pin.sourceDigest && equal(span.locator, source.locator), 'the old actual candidate has a different field/cell source')
      const mapping = await input.mappings.getMapping(input.scope, input.revision.ref.projectId, pin.mappingRef.id, pin.mappingRef.version, input.ctx)
      requireInput(mapping !== undefined && equal(mapping.ref, pin.mappingRef) && equal(mapping.originalRef, source.documentRef) && mapping.parseId === source.parseId && equal(mapping.definitionRef, pin.definitionRef) && equal(candidate.inputVersion.definitionRef, pin.definitionRef) && (outer['mappingRefs'] as unknown[]).some((ref) => equal(ref, mapping.ref)), 'the original immutable mapping/version differs from the captured source')
      const mappingDigest = producerDigest({ definitionRef: mapping.definitionRef, format: mapping.format, parseId: mapping.parseId, originalMediaType: mapping.originalMediaType, options: mapping.options, objectId: mapping.objectId, sheetId: mapping.sheetId ?? null, sheetName: mapping.sheetName ?? null, entries: [...mapping.entries].sort((left, right) => left.columnIndex - right.columnIndex) })
      requireInput(mappingDigest === mapping.ref.digest && mappingDigest === mapping.digest, 'the actual historical mapping failed its complete body hash')
      const entry = mapping.entries.filter((entry) => entry.fieldRef === fieldId)
      requireInput(entry.length === 1 && entry[0] !== undefined, 'the captured mapped field has no unique original column')
      const native = await input.native.read(mapping.originalRef, candidate.inputVersion.parserVersion, source.parseId, span.recordId, span.rowDigest, mapping.options, mapping.ref)
      const nativeCell = native.cells[entry[0].columnIndex], column = native.columns[entry[0].columnIndex]
      requireInput(nativeCell !== undefined && column !== undefined && equal(nativeCell.locator, source.locator) && nativeCell.raw === field['rawValue'] && column.header === entry[0].header && column.headerDigest === entry[0].headerDigest, 'the genuine original cell/header/raw token differs from the captured reviewed field')
      const parse = await input.parses.getParse(input.scope, source.parseId, input.ctx)
      requireInput(parse !== undefined && equal(parse.originalRef, source.documentRef), 'the captured original has no actual document projection parse reference')
      fences.set(`${pin.entityCandidateId}:${fieldId}`, async () => {
        requireInput(equal(await input.candidates.getCandidate(input.scope, pin.entityCandidateId, input.ctx), candidate) && equal(await input.mappings.getMapping(input.scope, input.revision.ref.projectId, pin.mappingRef.id, pin.mappingRef.version, input.ctx), mapping) && equal(await input.parses.getParse(input.scope, source.parseId, input.ctx), parse), 'the immutable original candidate/mapping/parse changed during source read')
        requireInput(equal(await input.ports.publications?.getReview(input.scope, pin.entityCandidateId, capturedReviewRevision, input.ctx), capturedReview) && (await input.confirmations.listConfirmations(input.scope, input.revision.ref.projectId, pin.entityCandidateId, input.ctx)).some((actual) => equal(actual, event)) && equal(await input.ports.publications?.getPublication(input.scope, address.publicationId, input.ctx), publication), 'the captured historical approval/confirmation/publication changed during source read')
        for (const revision of statementRevisions) requireInput(equal(await input.ports.publications?.getStatementRevision(input.scope, revision.statementId, revision.version, input.ctx), revision), 'the captured statement correction/retraction history changed during source read')
      })
      const key = sha256OfCanonical({ original: source.documentRef, parse: parse.spanMapRef, recordId: span.recordId, rowDigest: span.rowDigest })
      const previous = groups.get(key)
      groups.set(key, { precision: 'exact', originalRef: source.documentRef, parseRef: parse.spanMapRef, locator: native.entry.locator, cells: [...previous?.cells ?? [], { raw: nativeCell.raw, locator: nativeCell.locator, columnLabel: column.header, rowLabel: String(native.entry.row) }] })
    }
    verified += 1
    if (fragments.length + groups.size <= 10) { fragments.push(...groups.values()); displayed += 1 }
  }
  input.check()
  for (const fence of fences.values()) { input.check(); await fence() }
  await origin.after?.()
  input.check()
  const knownTotal = origin.knownTotal
  const truncated = displayed < knownTotal
  return { fragments, sourceReadLimitation: origin.mode !== 'saved_cell' ? `这里展示本次固定查询结果的原始输入来源，最多10行/10个原文件片段；已显示${displayed}行，共${knownTotal}行。` : '这里定位该已核验结果单元格绑定的原始输入字段；原始值保留导入时的单位与完整小数字符串。', sourceCoverage: { mode: origin.mode, requested: chosen.length, verified, displayed, knownTotal, truncated, coverage: truncated ? 'partial' : 'complete', maxRows: 10, maxFragments: 10 } }
}
