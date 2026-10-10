import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { RunServiceError, canonicalJson, sha256DigestOf } from '@ontology/application'
import type { TaskParameterValidator } from '@ontology/application'
import { assertProjectDatasetFieldSourcesShape, findRegisteredOperation, isRecord, isResourceRef, isUuid } from '@ontology/contracts'
import type { IndustrySchemaSource, OperationRegistry, ProjectRevision, PublishedTaskBinding, ResourceRef, ScopeRef, TaskInputSnapshotStore, ToolContext } from '@ontology/contracts'
import { EXAMPLE_COMPUTE_DATA_SCHEMA, EXAMPLE_OPERATION_REF, decodeExampleComputeInput, registeredOperationDigest } from '@ontology/tool-services'
import type { createCoreAuthoring } from './core-authoring'

/** Separate from a published operation's parameters: these are explicit original-field selections. */
export interface CoreComputeInputSelection {
  readonly objectId: string; readonly idField: string; readonly amountField: string
  readonly unitField?: string; readonly currencyField?: string
}
export function parseCoreComputeInputSelection(value: unknown): CoreComputeInputSelection {
  if (!isRecord(value) || Object.keys(value).some((key) => !['objectId','idField','amountField','unitField','currencyField'].includes(key)) ||
    ['objectId','idField','amountField'].some((key) => typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256) ||
    ['unitField','currencyField'].some((key) => value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256))) throw new RunServiceError('TASK_PARAMETER_INVALID', 'choose the actual object, identifier and amount fields for this computation')
  return { objectId: String(value['objectId']), idField: String(value['idField']), amountField: String(value['amountField']),
    ...(typeof value['unitField'] === 'string' ? { unitField: value['unitField'] } : {}), ...(typeof value['currencyField'] === 'string' ? { currencyField: value['currencyField'] } : {}) }
}

/** Prepare the registered rows input from actual approved pages, with a real derived-input receipt. */
export function createCoreProjectComputeInput(options: {
  readonly blobs: LocalImmutableBlobStore; readonly authoring: ReturnType<typeof createCoreAuthoring>
  readonly snapshots: TaskInputSnapshotStore; readonly schemas: IndustrySchemaSource; readonly operations: OperationRegistry
  readonly validator: TaskParameterValidator
  readonly validateBase: (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext, signal: AbortSignal) => Promise<ResourceRef>
}) {
  return async (scope: ScopeRef, revision: ProjectRevision, base: ResourceRef, binding: PublishedTaskBinding, supplied: unknown, ctx: ToolContext, signal: AbortSignal): Promise<ResourceRef> => {
    const check = () => { if (signal.aborted) throw new RunServiceError('DEADLINE_EXCEEDED', 'the computation input selection was cancelled', { cause: signal.reason }) }
    function invalid(message: string): never { throw new RunServiceError('INPUT_SNAPSHOT_INVALID', message) }
    const json = async (ref: ResourceRef, cap = 8_388_608): Promise<unknown> => {
      check()
      const metadata = await options.blobs.getAuthorizedMetadata({ scopeRef: scope, blobRef: ref }, ctx)
      if (metadata.byteSize > cap || metadata.contentDigest !== ref.digest) invalid('the fixed computation source exceeds its bounded immutable pin')
      const bytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
      if (sha256DigestOf(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) !== ref.digest) invalid('the fixed computation source bytes changed')
      check(); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    }
    check()
    const selection = parseCoreComputeInputSelection(supplied)
    const operation = binding.operationRef === undefined ? undefined : findRegisteredOperation(options.operations, binding.operationRef)
    if (binding.kind !== 'compute' || operation === undefined || registeredOperationDigest(operation) !== binding.registeredOperationDigest || canonicalJson(binding.actionDefinitionRef) !== canonicalJson(revision.definitionRef)) invalid('the computation does not bind its actual registered operation and active definition')
    if (canonicalJson(operation.operationRef) !== canonicalJson(EXAMPLE_OPERATION_REF)) invalid('this host has no approved-field input builder for the selected registered operation')
    const schema = await options.schemas.getSchema(scope, revision.definitionRef, ctx)
    const object = schema?.objects.find((object) => object.objectId === selection.objectId)
    const field = (id: string) => object?.attributes.find((attribute) => attribute.attributeId === id && attribute.maxCardinality === 1)
    if (object === undefined || !['string','enum'].includes(field(selection.idField)?.valueType ?? '') || !['quantity','number'].includes(field(selection.amountField)?.valueType ?? '') ||
      [selection.unitField,selection.currencyField].some((id) => id !== undefined && !['string','enum'].includes(field(id)?.valueType ?? ''))) throw new RunServiceError('TASK_PARAMETER_INVALID', 'the selected fields do not have the required identifier, amount, unit or currency types on this actual object')
    const body = await json(base)
    if (!isRecord(body) || body['schemaVersion'] !== 'project-input-snapshot@1' || body['projectId'] !== revision.ref.projectId || body['inputRevision'] !== revision.ref.revision || canonicalJson(body['definitionRef']) !== canonicalJson(revision.definitionRef) || !Array.isArray(body['recordPages']) || body['recordPages'].length > 200) invalid('the computation requires its actual approved project input archive')
    const rows: { id: string; amount: string; unit?: string; currency?: string }[] = [], origins: unknown[] = [], dependencies: ResourceRef[] = [base]
    const ids = new Set<string>()
    let inspected = 0
    for (const page of body['recordPages']) {
      check()
      if (!isRecord(page) || !isResourceRef(page['ref'])) invalid('the approved computation page selector is malformed')
      const value = await json(page['ref']); dependencies.push(page['ref'])
      if (!isRecord(value) || canonicalJson(value['projectRevisionRef']) !== canonicalJson(revision.ref) || canonicalJson(value['definitionRef']) !== canonicalJson(revision.definitionRef) || !Array.isArray(value['records']) || value['records'].length !== page['rowCount']) invalid('the approved computation page does not bind the exact stored project rows')
      inspected += value['records'].length
      if (inspected > 20_000) invalid('the approved computation page inventory exceeds its finite bound')
      for (const row of value['records']) {
        if (!isRecord(row) || !isUuid(row['recordId']) || !isRecord(row['values']) || !Array.isArray(row['sources'])) invalid('the approved computation row is malformed')
        const rowSources = row['sources']
        assertProjectDatasetFieldSourcesShape(rowSources)
        if (row['objectId'] !== selection.objectId) continue
        const values = row['values']
        const scalar = (id: string): string => { const cell = values[id]; if (!isRecord(cell) || cell['kind'] !== 'scalar' || typeof cell['value'] !== 'string' || cell['value'].length === 0) invalid('a selected identifier, unit or currency is not an actual confirmed string'); return cell['value'] }
        const id = scalar(selection.idField), amount = values[selection.amountField]
        if (ids.has(id)) invalid('the selected identifier repeats across approved physical rows; choose an unambiguous input field')
        ids.add(id)
        if (!isRecord(amount) || !['scalar','quantity'].includes(String(amount['kind'])) || typeof amount['value'] !== 'string') invalid('a selected amount is not an actual exact approved decimal')
        const unit = selection.unitField === undefined ? amount['kind'] === 'quantity' && typeof amount['unitCode'] === 'string' ? amount['unitCode'] : undefined : scalar(selection.unitField)
        if (amount['kind'] === 'quantity' && unit !== amount['unitCode']) invalid('the selected unit differs from the actual canonical quantity unit')
        const currency = selection.currencyField === undefined ? undefined : scalar(selection.currencyField)
        const selected = new Set([selection.idField,selection.amountField,...selection.unitField === undefined ? [] : [selection.unitField],...selection.currencyField === undefined ? [] : [selection.currencyField]])
        if ([...selected].some((id) => !rowSources.some((source) => source.fieldId === id))) invalid('a selected computation field has no actual archived original source binding')
        rows.push({ id, amount: amount['value'], ...(unit === undefined ? {} : { unit }), ...(currency === undefined ? {} : { currency }) })
        origins.push({ recordId: row['recordId'], sources: rowSources.filter((source) => selected.has(source.fieldId)) })
        if (rows.length > operation.limits.maxRows) invalid('the actual selected rows exceed the registered operation input limit')
      }
    }
    if (rows.length === 0 || !isRecord(body['counts']) || body['counts']['approved'] !== inspected) invalid('the computation has no complete approved input row selection')
    const input = { rows }, validation = options.validator.validate(EXAMPLE_COMPUTE_DATA_SCHEMA, input)
    if (!validation.valid) invalid(`the actual selected input does not satisfy the registered operation contract: ${validation.issues.join('; ')}`)
    const bytes = new TextEncoder().encode(canonicalJson(input))
    // This existing operation has fixed four-decimal arithmetic and each/CNY metrics.
    // Refuse unsupported observed data rather than silently rounding or changing its unit.
    const decoded = decodeExampleComputeInput(bytes)
    if (decoded.rows.some((row) => !/^(0|[1-9]\d*)(?:\.\d{1,4})?$/.test(row.amount) ||
      (row.unit !== undefined && row.unit !== 'each') || (row.currency !== undefined && row.currency !== 'CNY') ||
      row.unit !== 'each' && row.currency !== 'CNY')) invalid('the registered example only supports exact nonnegative amounts of up to four decimals in each or CNY')
    if (bytes.byteLength > operation.limits.maxBytes) invalid('the actual selected computation input exceeds its registered byte limit')
    const dataSchemaBytes = new TextEncoder().encode(canonicalJson(EXAMPLE_COMPUTE_DATA_SCHEMA))
    const dataSchemaRef = await options.authoring.stableWrite(`example-compute-data-schema:${sha256DigestOf(canonicalJson(EXAMPLE_COMPUTE_DATA_SCHEMA))}`, dataSchemaBytes, 'application/schema+json', 'artifact', ctx)
    const identity = `project-compute-input:${sha256DigestOf(canonicalJson({ base, binding: binding.taskBindingRef, selection }))}`
    const ref = await options.authoring.stableWrite(identity, bytes, 'application/json', 'artifact', ctx)
    const selectionRef = await options.authoring.stableWrite(`${identity}:source-selection`, new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-compute-input-selection@1', projectRevisionRef: revision.ref, baseInputRef: base, inputRef: ref, taskBindingRef: binding.taskBindingRef, operationRef: operation.operationRef, registeredOperationDigest: binding.registeredOperationDigest, parameterSchemaDigest: operation.inputSchemaDigest, dataSchemaRef, selection, records: origins })), 'application/json', 'artifact', ctx)
    if (canonicalJson(await options.validateBase(scope, revision, ctx, signal)) !== canonicalJson(base)) invalid('the actual approved project input changed while computation inputs were prepared')
    const existing = await options.snapshots.getSnapshot(scope, ref, ctx)
    const semantic = { schemaVersion: 'task-input-snapshot@1' as const, projectId: revision.ref.projectId, projectRevisionRef: revision.ref, baseInputRef: base, baseInputDigest: base.digest,
      inputSchemaRef: { id: dataSchemaRef.id, version: dataSchemaRef.version, digest: dataSchemaRef.digest }, dependencies: [...dependencies,dataSchemaRef,selectionRef], producedBy: 'core-approved-project-compute-input@1' }
    if (existing !== undefined) { const { producedAt, ...saved } = existing.body; void producedAt; if (canonicalJson(saved) !== canonicalJson(semantic)) invalid('the actual derived computation metadata differs from its original source selection') }
    else await options.snapshots.putSnapshot(scope, { ref, body: { ...semantic, producedAt: new Date().toISOString() } }, ctx)
    check(); return ref
  }
}
