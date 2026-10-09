import { createHash } from 'node:crypto'
import { isRecord, isResourceRef } from '@ontology/contracts'
import type { ApprovedInputSnapshot, CandidateStore, IndustrySchemaSource, InstanceReviewStore, ProjectDocumentStore, ProjectPublishedDatasetSource, ProjectRecordStore, ProjectRevision, ProjectStore, ReviewableCandidateReader, ScopedArtifactReader, ScopeRef, SemanticPublicationStore, ToolContext } from '@ontology/contracts'
import { RunServiceError, canonicalJson, sha256DigestOf } from '@ontology/application'
import { InvalidRequestFieldError } from '../http/shared'
import type { createCoreAuthoring } from './core-authoring'

/** Actual normal-run input archives are execution receipts, never a new human approval ledger. */
export function createCoreApprovedInput(options: {
  readonly projects: ProjectStore; readonly documents: ProjectDocumentStore; readonly records: ProjectRecordStore
  readonly instances: InstanceReviewStore; readonly candidates: CandidateStore; readonly reviews: SemanticPublicationStore
  readonly reviewable: ReviewableCandidateReader; readonly schemas: IndustrySchemaSource; readonly source: ProjectPublishedDatasetSource
  readonly reader: ScopedArtifactReader; readonly authoring: ReturnType<typeof createCoreAuthoring>
}) {
  const readMany = async <T,R>(values: readonly T[], read: (value: T) => Promise<R>): Promise<R[]> => {
    const result: R[] = []
    let next = 0
    let failed = false
    await Promise.all(Array.from({ length: Math.min(4,values.length) },async () => {
      while (!failed && next < values.length) {
        const index = next++, value = values[index]
        if (value === undefined) throw new InvalidRequestFieldError('the bounded current input read selector is missing')
        try { result[index] = await read(value) } catch (error) { failed = true; throw error }
      }
    }))
    return result
  }
  const readJson = async (ref: Parameters<ScopedArtifactReader['read']>[0]['approvedInputRefs'][number], ctx: ToolContext): Promise<unknown> => {
    const bytes = await options.reader.read({ approvedInputRefs: [ref] }, ctx)
    if (bytes.byteLength > 8_388_608 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref.digest) throw new InvalidRequestFieldError('the actual approved input artifact failed byte integrity')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  }
  const readCapture = async (manifest: unknown, body: Readonly<Record<string, unknown>>, revision: ProjectRevision, ctx: ToolContext, signal?: AbortSignal) => {
    const invalid = (): never => { throw new InvalidRequestFieldError('the actual normal input confirmation pages are malformed or detached') }
    const checkRead = () => { if (signal?.aborted === true) throw new RunServiceError('DEADLINE_EXCEEDED','the approved input page read was cancelled',{ cause: signal.reason }) }
    const read = async (ref: import('@ontology/contracts').ResourceRef) => {
      checkRead()
      const value = await readJson(ref,ctx)
      checkRead()
      return value
    }
    if (!isRecord(manifest) || !isRecord(manifest['semanticPins'])) return invalid()
    const semanticPins = manifest['semanticPins']
    if (manifest['normalArchiveVersion'] === undefined) {
      if (!Array.isArray(manifest['human'])) return invalid()
      return { selection: manifest['semanticPins'], human: manifest['human'] }
    }
    if (manifest['normalArchiveVersion'] !== 'paged@1' || canonicalJson(manifest['projectRevisionRef']) !== canonicalJson(revision.ref) ||
      canonicalJson(manifest['recordPages']) !== canonicalJson(body['recordPages']) || !Array.isArray(body['recordPages']) ||
      !Array.isArray(manifest['physicalPages']) || manifest['physicalPages'].length > 200 || !Array.isArray(manifest['confirmationPages']) || manifest['confirmationPages'].length > 200 ||
      ['physical','rows','human'].some((key) => key in semanticPins)) return invalid()
    const physical: unknown[] = [], rows: unknown[] = [], human: Record<string, unknown>[] = []
    for (const ref of manifest['physicalPages']) {
      if (!isResourceRef(ref)) return invalid()
      const page = await read(ref)
      if (!isRecord(page) || page['schemaVersion'] !== 'project-input-physical-page@1' || canonicalJson(page['projectRevisionRef']) !== canonicalJson(revision.ref) || !Array.isArray(page['records']) || page['records'].length > 100) return invalid()
      physical.push(...page['records'])
    }
    for (const pin of body['recordPages']) {
      if (!isRecord(pin) || !isResourceRef(pin['ref'])) return invalid()
      const page = await read(pin['ref'])
      if (!isRecord(page) || page['schemaVersion'] !== 'project-input-record-page@1' || canonicalJson(page['projectRevisionRef']) !== canonicalJson(revision.ref) || canonicalJson(page['definitionRef']) !== canonicalJson(revision.definitionRef) || !Array.isArray(page['records']) || page['records'].length !== pin['rowCount'] || page['records'].length > 100 || page['records'][0]?.['recordId'] !== pin['firstRecordId'] || page['records'].at(-1)?.['recordId'] !== pin['lastRecordId']) return invalid()
      rows.push(...page['records'])
    }
    for (const ref of manifest['confirmationPages']) {
      if (!isResourceRef(ref)) return invalid()
      const page = await read(ref)
      if (!isRecord(page) || page['schemaVersion'] !== 'project-input-confirmations-page@1' || canonicalJson(page['projectRevisionRef']) !== canonicalJson(revision.ref) || !Array.isArray(page['confirmations']) || page['confirmations'].length > 100) return invalid()
      for (const row of page['confirmations']) { if (!isRecord(row) || !isRecord(row['review'])) return invalid(); human.push(row) }
    }
    if (physical.length > 20_000 || rows.length > 20_000 || human.length > 20_000) return invalid()
    const selection = { ...manifest['semanticPins'], physical, rows,
      human: human.map(({ review, ...row }) => { if (!isRecord(review)) return invalid(); return { ...row, review: { candidateId: row['candidateId'], contentDigest: review['contentDigest'], decision: review['decision'] } } }) }
    if (sha256DigestOf(canonicalJson(selection)) !== manifest['semanticPinsDigest']) return invalid()
    return { selection, human }
  }
  const collect = async (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext, signal?: AbortSignal, frozen?: Readonly<Record<string, unknown>>) => {
    const check = () => { if (signal?.aborted === true) throw new RunServiceError('DEADLINE_EXCEEDED', 'the normal input capture was cancelled', { cause: signal.reason }) }
    check()
    const project = await options.projects.getProject(scope, revision.ref.projectId, ctx)
    if (project === undefined || project.state === 'archived' || (project.activeRevision ?? project.headRevision) !== revision.ref.revision || canonicalJson(await options.projects.getRevision(scope, revision.ref.projectId, revision.ref.revision, ctx)) !== canonicalJson(revision)) throw new InvalidRequestFieldError('normal input requires the exact authorized active project revision')
    if (revision.executionPurpose === 'synthetic_validation') throw new InvalidRequestFieldError('private competency inputs cannot become ordinary observed business inputs')
    const visibility = await options.documents.getVisibility(scope, revision.ref.projectId, ctx)
    const allMembers = await options.documents.listDocuments(scope, revision.ref.projectId, { state: 'active', limit: 200 }, ctx)
    if (allMembers.nextCursor !== null) throw new InvalidRequestFieldError('the current input source inventory exceeds 200 originals')
    const frozenMembers = frozen?.['members']
    if (frozen !== undefined && (!Array.isArray(frozenMembers) || frozenMembers.length > 200)) throw new InvalidRequestFieldError('the accepted previous input source selection is malformed')
    const selectedMembers = Array.isArray(frozenMembers) ? allMembers.memberships.filter((member) => frozenMembers.some((saved: unknown) => isRecord(saved) && saved['documentId'] === member.documentId)) : allMembers.memberships
    if (Array.isArray(frozenMembers) && canonicalJson(selectedMembers) !== canonicalJson(frozenMembers)) throw new InvalidRequestFieldError('an accepted previous original membership changed during staging')
    const members = { ...allMembers, memberships: selectedMembers }
    const corpus = await readJson(revision.documentSetRef, ctx)
    const expectedMembers = members.memberships.map((member) => ({ documentId: member.documentId, documentRef: member.documentRef, parseId: member.parseId, parseRef: member.parseRef, membershipRevision: member.membershipRevision, precision: member.precision }))
    if (!isRecord(corpus) || corpus['schemaVersion'] !== 'project-document-set@1' || corpus['projectId'] !== revision.ref.projectId || canonicalJson(corpus['members']) !== canonicalJson(expectedMembers)) throw new InvalidRequestFieldError('the fixed project corpus does not bind its actual active source membership')
    const schema = await options.schemas.getSchema(scope, revision.definitionRef, ctx)
    if (schema === undefined || schema.objects.length > 64) throw new InvalidRequestFieldError('the current input definition is unavailable or exceeds its finite object bound')
    const semantic = await options.reviews.latestReadRevision(scope, ctx)
    const allPhysical = []
    let cursor: string | undefined
    do {
      check()
      const page = await options.records.listRecords(scope, revision.ref.projectId, { limit: 250, ...(cursor === undefined ? {} : { cursor }) }, ctx)
      allPhysical.push(...page.records)
      if (allPhysical.length > 20_000 || cursor !== undefined && page.nextCursor === cursor) throw new InvalidRequestFieldError('the normal input record inventory exceeded its finite bound')
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const frozenPhysical = frozen?.['physical']
    if (frozen !== undefined && (!Array.isArray(frozenPhysical) || frozenPhysical.length > 20_000)) throw new InvalidRequestFieldError('the accepted previous physical selection is malformed')
    const selectedRecordIds = Array.isArray(frozenPhysical) ? new Set(frozenPhysical.flatMap((saved: unknown) => isRecord(saved) && typeof saved['recordId'] === 'string' ? [saved['recordId']] : [])) : undefined
    const physical = selectedRecordIds === undefined ? allPhysical : allPhysical.filter((record) => selectedRecordIds.has(record.recordId))
    if (Array.isArray(frozenPhysical) && canonicalJson(physical) !== canonicalJson(frozenPhysical)) throw new InvalidRequestFieldError('an accepted previous physical original record changed during staging')
    const rows = []
    const sources = []
    let statementsRead = 0
    for (const object of schema.objects) {
      check()
      // A staging-only object is explicitly excluded; it is never promoted into query values.
      let afterStatementId: string | undefined
      let hasOwnPublished = false
      do {
        check()
        const page = await options.reviews.listStatements(scope, { objectId: object.objectId, status: 'active', limit: 250, ...(afterStatementId === undefined ? {} : { afterStatementId }) }, ctx)
        statementsRead += page.length
        if (statementsRead > 20_000) throw new InvalidRequestFieldError('the official normal input statement inventory exceeded its finite bound')
        for (const statement of page) {
          const provenance = statement.value['provenance']
          if (isRecord(provenance) && Array.isArray(provenance['sources']) && provenance['sources'].some((pin: unknown) => isRecord(pin) && isRecord(pin['projectRevisionRef']) && pin['projectRevisionRef']['projectId'] === revision.ref.projectId && pin['projectRevisionRef']['revision'] === revision.ref.revision)) hasOwnPublished = true
        }
        if (page.length < 250) break
        const last = page.at(-1)?.statementId
        if (last === undefined || last === afterStatementId) throw new InvalidRequestFieldError('the official statement inventory did not advance')
        afterStatementId = last
      } while (!hasOwnPublished)
      if (!hasOwnPublished) continue
      const official = await options.source.read(scope, revision, object.objectId, ctx)
      if (official.coverage.completeness !== 'complete' || official.rows.length + rows.length > 20_000) throw new InvalidRequestFieldError('the normal input official row coverage is incomplete')
      rows.push(...official.rows)
      sources.push({ objectId: object.objectId, sourceDigest: official.sourceDigest, factRecordedPoint: official.factRecordedPoint })
    }
    rows.sort((left, right) => left.recordId.localeCompare(right.recordId))
    if (new Set(rows.map((row) => row.recordId)).size !== rows.length) throw new InvalidRequestFieldError('multiple official rows share a physical input record')
    const statementVersions = new Map<string,string>()
    for (const row of rows) for (const source of row.sources) {
      check()
      if (source.statementId === undefined || source.statementVersion === undefined || statementVersions.has(source.statementId) && statementVersions.get(source.statementId) !== source.statementVersion) throw new InvalidRequestFieldError('an official input field lacks one exact actual statement origin/version')
      statementVersions.set(source.statementId,source.statementVersion)
    }
    const statements = await readMany([...statementVersions],async ([statementId,version]) => {
      check()
      const statement = await options.reviews.getStatement(scope,statementId,ctx)
      if (statement === undefined || statement.version !== version || statement.status !== 'active') throw new InvalidRequestFieldError('the input statement origin changed')
      check(); return statement
    })
    const human = await readMany([...new Set(statements.map((statement) => statement.sourceCandidateId))],async (candidateId) => {
      check()
      const [candidate,instance,events,reviewRevision,view] = await Promise.all([
        options.candidates.getCandidate(scope,candidateId,ctx),options.instances.getRecord(scope,revision.ref.projectId,candidateId,ctx),
        options.instances.listConfirmations(scope,revision.ref.projectId,candidateId,ctx),options.reviews.latestReviewRevision(scope,candidateId,ctx),options.reviewable.readCandidate(scope,candidateId,ctx),
      ])
      const review = await options.reviews.getReview(scope,candidateId,reviewRevision,ctx)
      if (candidate?.kind !== 'entity' || instance === undefined || canonicalJson(instance.identity.binding?.projectRevisionRef) !== canonicalJson(revision.ref) || !['matched', 'created'].includes(instance.identity.state) || instance.fields.length !== candidate.attributes.length || instance.fields.some((field) => {
        const attribute = candidate.attributes.find((attribute) => attribute.attributeId === field.fieldId)
        const declared = schema.objects.find((object) => object.objectId === candidate.objectId)?.attributes.find((attribute) => attribute.attributeId === field.fieldId)
        return field.status !== 'confirmed' || field.actor === undefined || field.confirmedAt === undefined || attribute === undefined || field.rawValue !== attribute.raw ||
          (declared?.valueType === 'reference' ? field.normalizedValue?.kind !== 'reference' || field.normalizedValue.entityId !== attribute.value : field.normalizedValue?.kind === 'quantity' ? field.normalizedValue.value !== attribute.value || field.normalizedValue.unitCode !== attribute.unitCode : field.normalizedValue?.kind !== 'scalar' || field.normalizedValue.value !== attribute.value) ||
          !events.some((event) => event.fieldId === field.fieldId && event.confirmationRevision === field.confirmationRevision && event.actor === field.actor && event.status === 'confirmed')
      }) || view?.contentDigest === undefined || review?.decision !== 'approve' || review.contentDigest !== view.contentDigest) throw new InvalidRequestFieldError('the current input lacks actual field, identity or content-pinned human review evidence')
      check(); return { candidateId: candidate.candidateId, candidateDigest: view.contentDigest, instance, events, review }
    })
    human.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    const allowed = new Set(rows.map((row) => row.recordId))
    const excluded = physical.filter((record) => !allowed.has(record.recordId)).map((record) => ({ recordId: record.recordId, reason: 'not_in_current_published_original_input', actor: ctx.principal.subjectId }))
    const current = { project: { projectId: project.projectId, activeRevision: revision.ref.revision }, revision, visibility, members: members.memberships, physical, sources, rows,
      human: human.map(({ review, ...row }) => ({ ...row, review: { candidateId: row.candidateId, contentDigest: review.contentDigest, decision: review.decision } })) }
    const checkSources = async () => {
      check()
      if (canonicalJson(await options.projects.getProject(scope, revision.ref.projectId, ctx)) !== canonicalJson(project) || canonicalJson(await options.documents.getVisibility(scope, revision.ref.projectId, ctx)) !== canonicalJson(visibility) || canonicalJson(await options.documents.listDocuments(scope, revision.ref.projectId, { state: 'active', limit: 200 }, ctx)) !== canonicalJson(allMembers) || await options.reviews.latestReadRevision(scope, ctx) !== semantic) throw new InvalidRequestFieldError('the actual project or source head changed during normal input capture')
    }
    await checkSources()
    await readMany(human,async (captured) => {
      check()
      const [record,head,view] = await Promise.all([options.instances.getRecord(scope,revision.ref.projectId,captured.candidateId,ctx),options.reviews.latestReviewRevision(scope,captured.candidateId,ctx),options.reviewable.readCandidate(scope,captured.candidateId,ctx)])
      const review = await options.reviews.getReview(scope, captured.candidateId, head, ctx)
      if (canonicalJson(record) !== canonicalJson(captured.instance) || review?.decision !== 'approve' || review.contentDigest !== captured.candidateDigest || view?.contentDigest !== captured.candidateDigest) throw new InvalidRequestFieldError('the actual human field/identity/content approval changed during source capture')
      check()
    })
    await checkSources()
    check()
    return { current, human, excluded, semantic }
  }
  const validateCaptured = async (scope: ScopeRef, revision: ProjectRevision, ref: import('@ontology/contracts').ResourceRef, ctx: ToolContext, signal?: AbortSignal) => {
    const check = () => { if (signal?.aborted === true) throw new RunServiceError('DEADLINE_EXCEEDED', 'the previous input validation was cancelled', { cause: signal.reason }) }
    const invalid = (): never => { throw new InvalidRequestFieldError('the accepted previous input no longer binds its actual original rows and current human authority') }
    check()
    const body = await readJson(ref, ctx)
    if (!isRecord(body) || body['schemaVersion'] !== 'project-input-snapshot@1' || body['projectId'] !== revision.ref.projectId || body['inputRevision'] !== revision.ref.revision || canonicalJson(body['definitionRef']) !== canonicalJson(revision.definitionRef) || canonicalJson(body['mappingRefs']) !== canonicalJson(revision.mappingRefs) || !isResourceRef(body['confirmationManifestRef']) || !Array.isArray(body['recordPages']) || body['recordPages'].length > 200) return invalid()
    const manifest = await readJson(body['confirmationManifestRef'], ctx)
    const capture = await readCapture(manifest,body,revision,ctx,signal)
    const selection = capture.selection
    const collected = await collect(scope, revision, ctx, signal, selection)
    if (canonicalJson(collected.current) !== canonicalJson(selection)) invalid()
    const archived: unknown[] = []
    for (const page of body['recordPages']) {
      check()
      if (!isRecord(page) || !isResourceRef(page['ref']) || typeof page['rowCount'] !== 'number') return invalid()
      const value = await readJson(page['ref'], ctx)
      if (!isRecord(value) || canonicalJson(value['projectRevisionRef']) !== canonicalJson(revision.ref) || canonicalJson(value['definitionRef']) !== canonicalJson(revision.definitionRef) || !Array.isArray(value['records']) || value['records'].length !== page['rowCount'] || value['records'][0]?.['recordId'] !== page['firstRecordId'] || value['records'].at(-1)?.['recordId'] !== page['lastRecordId']) return invalid()
      archived.push(...value['records'])
    }
    const excluded = body['excluded']
    if (!Array.isArray(excluded) || excluded.some((row: unknown) => !isRecord(row) || typeof row['actor'] !== 'string' || row['actor'].trim() === '')) return invalid()
    if (canonicalJson(archived) !== canonicalJson(collected.current.rows) || canonicalJson(excluded.map((row: unknown) => { if (!isRecord(row)) return invalid(); return { recordId: row['recordId'], reason: row['reason'] } })) !== canonicalJson(collected.excluded.map(({ recordId, reason }) => ({ recordId, reason }))) || !isRecord(body['counts']) || body['counts']['approved'] !== archived.length || body['counts']['confirmed'] !== archived.length || body['counts']['pending'] !== 0 || body['counts']['failed'] !== 0 || body['counts']['excluded'] !== collected.excluded.length || body['counts']['total'] !== archived.length + collected.excluded.length || body['coverage'] !== 'complete') invalid()
    if (capture.human.length !== collected.human.length) invalid()
    const savedHumans = new Map(capture.human.map((row: unknown) => { if (!isRecord(row) || typeof row['candidateId'] !== 'string') return invalid(); return [row['candidateId'], row] as const }))
    if (savedHumans.size !== capture.human.length) invalid()
    await readMany(collected.human,async (current) => {
      check()
      const saved = savedHumans.get(current.candidateId)
      if (!isRecord(saved) || !isRecord(saved['review']) || typeof saved['review']['revision'] !== 'string') return invalid()
      const actual = await options.reviews.getReview(scope, current.candidateId, saved['review']['revision'], ctx)
      if (actual?.decision !== 'approve' || actual.contentDigest !== current.candidateDigest || canonicalJson(saved) !== canonicalJson({ ...current, review: actual })) invalid()
      check()
    })
    let bytesRead = 0
    for (const member of collected.current.members) {
      check()
      const bytes = await options.reader.read({ approvedInputRefs: [member.documentRef] }, ctx)
      bytesRead += bytes.byteLength
      if (bytesRead > 33_554_432 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== member.documentRef.digest) invalid()
    }
    const after = await collect(scope, revision, ctx, signal, selection)
    if (after.semantic !== collected.semantic || canonicalJson(after.current) !== canonicalJson(collected.current)) invalid()
    check()
    return ref
  }
  return { validateCaptured, resolve: async (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext, signal?: AbortSignal) => {
    const check = () => { if (signal?.aborted === true) throw new RunServiceError('DEADLINE_EXCEEDED', 'the normal input capture was cancelled', { cause: signal.reason }) }
    check()
    const collected = await collect(scope, revision, ctx, signal)
    const identity = `normal-approved-input:${revision.ref.projectId}:${sha256DigestOf(canonicalJson(collected.current))}`
    const existing = await options.authoring.findStableArtifact(identity, ctx)
    const validateSourcesAndCurrent = async () => {
      let bytesRead = 0
      for (const member of collected.current.members) {
        check()
        const bytes = await options.reader.read({ approvedInputRefs: [member.documentRef] }, ctx)
        bytesRead += bytes.byteLength
        if (bytesRead > 33_554_432 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== member.documentRef.digest) throw new InvalidRequestFieldError('the actual input original bytes changed or exceeded 32 MiB')
      }
      const after = await collect(scope, revision, ctx, signal)
      if (after.semantic !== collected.semantic || canonicalJson(after.current) !== canonicalJson(collected.current)) throw new InvalidRequestFieldError('the actual normal input source or human authority changed during archival')
    }
    if (existing !== undefined) {
      const saved = await readJson(existing, ctx)
      if (!isRecord(saved) || saved['schemaVersion'] !== 'project-input-snapshot@1' || saved['projectId'] !== revision.ref.projectId || saved['inputRevision'] !== revision.ref.revision || !isResourceRef(saved['confirmationManifestRef'])) throw new InvalidRequestFieldError('the actual prior input archive is malformed')
      const manifest = await readJson(saved['confirmationManifestRef'], ctx)
      const capture = await readCapture(manifest,saved,revision,ctx,signal)
      if (canonicalJson(capture.selection) !== canonicalJson(collected.current)) throw new InvalidRequestFieldError('the prior input archive does not bind current actual authority')
      await readMany(capture.human,async (row) => {
        check()
        if (!isRecord(row) || typeof row['candidateId'] !== 'string' || !isRecord(row['review']) || typeof row['review']['revision'] !== 'string') throw new InvalidRequestFieldError('a captured actual review pin is malformed')
        const actual = await options.reviews.getReview(scope, row['candidateId'], row['review']['revision'], ctx)
        if (canonicalJson(actual) !== canonicalJson(row['review'])) throw new InvalidRequestFieldError('the captured approval does not match its real immutable ledger act')
        check()
      })
      await validateSourcesAndCurrent()
      check()
      return existing
    }
    const writePage = async (key: string, body: unknown) => {
      check()
      const bytes = new TextEncoder().encode(canonicalJson(body))
      if (bytes.byteLength > 8_388_608) throw new InvalidRequestFieldError('an actual normal input page exceeds its bounded artifact size')
      return options.authoring.stableWrite(key,bytes,'application/json','artifact',ctx)
    }
    const pages: ApprovedInputSnapshot['recordPages'] = []
    check()
    for (let offset = 0; offset < collected.current.rows.length; offset += 100) {
      check()
      const rows = collected.current.rows.slice(offset, offset + 100)
      const first = rows[0], last = rows.at(-1)
      if (first === undefined || last === undefined) throw new InvalidRequestFieldError('the actual input page is empty')
      const ref = await writePage(`${identity}:page:${offset}`, { schemaVersion: 'project-input-record-page@1', projectRevisionRef: revision.ref, definitionRef: revision.definitionRef, records: rows })
      pages.push({ ref, rowCount: rows.length, firstRecordId: first.recordId, lastRecordId: last.recordId })
    }
    const physicalPages = [], confirmationPages = []
    for (let offset = 0; offset < collected.current.physical.length; offset += 100) physicalPages.push(await writePage(`${identity}:physical:${offset}`, { schemaVersion: 'project-input-physical-page@1', projectRevisionRef: revision.ref, records: collected.current.physical.slice(offset,offset+100) }))
    for (let offset = 0; offset < collected.human.length; offset += 100) confirmationPages.push(await writePage(`${identity}:human:${offset}`, { schemaVersion: 'project-input-confirmations-page@1', projectRevisionRef: revision.ref, confirmations: collected.human.slice(offset,offset+100) }))
    const { physical, rows, human: semanticHuman, ...semanticPins } = collected.current
    void physical; void rows; void semanticHuman
    const confirmationManifestRef = await writePage(`${identity}:human`, { schemaVersion: 'project-input-confirmations@1', normalArchiveVersion: 'paged@1', projectRevisionRef: revision.ref,
      semanticPins, semanticPinsDigest: sha256DigestOf(canonicalJson(collected.current)), recordPages: pages, physicalPages, confirmationPages })
    const body: ApprovedInputSnapshot = { schemaVersion: 'project-input-snapshot@1', projectId: revision.ref.projectId, inputRevision: revision.ref.revision,
      definitionRef: revision.definitionRef, mappingRefs: [...revision.mappingRefs], recordPages: pages,
      counts: { total: collected.current.rows.length + collected.excluded.length, confirmed: collected.current.rows.length, approved: collected.current.rows.length, excluded: collected.excluded.length, pending: 0, failed: 0 },
      excluded: collected.excluded, coverage: 'complete', confirmationManifestRef }
    const ref = await writePage(identity,body)
    await validateSourcesAndCurrent()
    check()
    return ref
  } }
}
