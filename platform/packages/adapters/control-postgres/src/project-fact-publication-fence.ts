import { SemanticPublicationStoreError, assertProjectFactInputShape } from '@ontology/contracts'
import type { CandidateKind, CandidateSourceSpan, EntityCandidate, ExtractionInputVersion, InstanceFieldValue, InstanceIdentityBinding, ProjectFactPublicationFence, PublishSemanticPublicationInput, VersionRef } from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { assertIdentityProjectFence } from './identity-project-fence'

interface Query {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

const SCOPE = `tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid`

function blocked(): never {
  throw new SemanticPublicationStoreError('IDENTITY_CONSTRAINT_BLOCKED', 'mapped fact source, confirmation, approval or human identity changed before publication commit')
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

/** Source/project first, then identity heads/targets: same order as GAP-005 decisions. */
export async function assertProjectFactPublicationFences(query: Query, input: PublishSemanticPublicationInput): Promise<void> {
  const candidates = await query.query<{ candidate_id: string; kind: CandidateKind; idempotency_key: string; input_version: ExtractionInputVersion }>(
    `SELECT candidate_id,kind,idempotency_key,input_version FROM agent_platform.extraction_candidates
      WHERE ${SCOPE} AND candidate_id=ANY($1::uuid[]) ORDER BY candidate_id`,
    [[...new Set([...input.publication.approvedCandidateRefs.map((ref) => ref.candidateId), ...input.publication.statements.map((statement) => statement.sourceCandidateId)])]],
  )
  const fences = input.projectFactFences ?? []
  for (const candidate of candidates.rows) {
    if (candidate.input_version.projectFact === undefined) continue
    assertProjectFactInputShape(candidate.input_version.projectFact)
    const statement = input.publication.statements.find((entry) => entry.sourceCandidateId === candidate.candidate_id)
    if (statement === undefined || statement.statementId !== candidate.candidate_id || !input.publication.approvedCandidateRefs.some((ref) => ref.candidateId === candidate.candidate_id && ref.kind === candidate.kind)) blocked()
    // Even a direct store caller cannot replace the stored reviewed semantic payload.
    const provenance = statement.value['provenance']
    const spans = provenance !== null && typeof provenance === 'object' && 'sourceSpans' in provenance ? provenance.sourceSpans : null
    const exact = await query.query<{ exact: boolean }>(
      `SELECT state='pending_review' AND definition_ref=$2::jsonb AND source_spans=$3::jsonb
        AND input_version->'projectFact'=($4::jsonb - 'sourceSpans')
        AND CASE WHEN kind='entity' THEN payload->'attributes' @> $5::jsonb AND payload->'attributes' <@ $5::jsonb
          WHEN kind='relation' THEN payload->'from'=$6::jsonb AND payload->'to'=$7::jsonb ELSE false END AS exact
       FROM agent_platform.extraction_candidates WHERE ${SCOPE} AND candidate_id=$1::uuid`,
      [candidate.candidate_id, JSON.stringify(input.publication.schemaRef), JSON.stringify(spans), JSON.stringify(provenance ?? null), JSON.stringify(statement.value['attributes'] ?? null), JSON.stringify(statement.value['from'] ?? null), JSON.stringify(statement.value['to'] ?? null)],
    )
    if (exact.rows[0]?.exact !== true || statement.validFrom !== candidate.input_version.projectFact.validFrom || statement.validTo !== candidate.input_version.projectFact.validTo) blocked()
  }
  const expected = candidates.rows.flatMap((candidate) => (candidate.input_version.projectFact?.sources ?? []).map((source) => ({ candidate, source })))
  if (expected.length !== fences.length) blocked()
  for (const { candidate, source } of [...expected].sort((a, b) => a.source.projectRevisionRef.projectId.localeCompare(b.source.projectRevisionRef.projectId))) {
    const fence = fences.find((entry) => entry.candidateId === candidate.candidate_id && entry.source.entityCandidateId === source.entityCandidateId)
    if (fence === undefined || fence.candidateDigest !== candidate.idempotency_key ||
      !sameRef(source.definitionRef, fence.source.definitionRef) || !sameRef(source.mappingRef, fence.source.mappingRef) ||
      source.projectRevisionRef.projectId !== fence.source.projectRevisionRef.projectId || source.projectRevisionRef.revision !== fence.source.projectRevisionRef.revision || source.projectRevisionRef.digest !== fence.source.projectRevisionRef.digest ||
      source.recordId !== fence.source.recordId || source.recordRevision !== fence.source.recordRevision || source.contentDigest !== fence.source.contentDigest || source.sourceDigest !== fence.source.sourceDigest || source.documentId !== fence.source.documentId || source.parseId !== fence.source.parseId || source.membershipRevision !== fence.source.membershipRevision || source.visibilityEpoch !== fence.source.visibilityEpoch) blocked()
    await assertIdentityProjectFence(query, { projectRevisionRef: source.projectRevisionRef, definitionRef: source.definitionRef, documentId: source.documentId, parseId: source.parseId, membershipRevision: source.membershipRevision, visibilityEpoch: source.visibilityEpoch })
    const mapping = await query.query<{ digest: string; definition_ref: VersionRef }>(
      `SELECT digest,definition_ref FROM agent_platform.project_mapping_versions WHERE ${SCOPE}
        AND project_id=$1::uuid AND mapping_id=$2::uuid AND version=$3`,
      [source.projectRevisionRef.projectId, source.mappingRef.id, source.mappingRef.version],
    )
    const revision = await query.query<{ mappings: VersionRef[] }>(
      `SELECT body->'mappingRefs' AS mappings FROM agent_platform.project_revisions WHERE ${SCOPE} AND project_id=$1::uuid AND revision=$2::bigint`,
      [source.projectRevisionRef.projectId, source.projectRevisionRef.revision],
    )
    const record = await query.query<{ revision: string; content_digest: string; source_digest: string; status: string; mapping_id: string; mapping_version: string }>(
      `SELECT revision::text,content_digest,source_digest,status,mapping_id,mapping_version FROM agent_platform.project_record_versions WHERE ${SCOPE}
        AND project_id=$1::uuid AND record_id=$2::uuid ORDER BY revision DESC LIMIT 1`,
      [source.projectRevisionRef.projectId, source.recordId],
    )
    const parse = await query.query<{ parse_status: string; completeness: string; pending: string }>(
      `SELECT parse_status,coverage->>'completeness' AS completeness,
        ((counts->>'pending')::bigint+(counts->>'failed')::bigint+(counts->>'skipped')::bigint)::text AS pending
       FROM agent_platform.document_structured_parses WHERE ${SCOPE} AND parse_id=$1::uuid`, [source.parseId],
    )
    const current = record.rows[0]
    if (mapping.rows[0]?.digest !== source.mappingRef.digest || !sameRef(mapping.rows[0].definition_ref, source.definitionRef) || !revision.rows[0]?.mappings.some((ref) => sameRef(ref, source.mappingRef)) ||
      current?.revision !== source.recordRevision || current.content_digest !== source.contentDigest || current.source_digest !== source.sourceDigest || current.status !== 'confirmed' || current.mapping_id !== source.mappingRef.id || current.mapping_version !== source.mappingRef.version ||
      parse.rows[0]?.parse_status !== 'complete' || parse.rows[0].completeness !== 'complete' || parse.rows[0].pending !== '0') blocked()
    const values = await query.query<{ exact: boolean }>(
      `SELECT jsonb_array_length(r.body->'fields')=jsonb_array_length(c.payload->'attributes')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.body->'fields') field
          WHERE field->>'status'<>'confirmed' OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(c.payload->'attributes') attribute
            WHERE attribute->>'attributeId'=field->>'fieldId' AND attribute->'raw'=field->'raw'
              AND CASE WHEN field->'normalized'->>'kind'='quantity'
                THEN field->'normalized'->>'unitCode'=attribute->>'unitCode'
                  AND (field->'normalized'->>'value')::numeric=(attribute->>'value')::numeric
                WHEN attribute->>'decimal' IS NOT NULL AND attribute->>'unitCode' IS NULL
                THEN (field->'normalized'->>'value')::numeric=(attribute->>'value')::numeric
                ELSE field->'normalized'->'value'=attribute->'value' END
          )
        ) AS exact FROM agent_platform.project_record_versions r
        JOIN agent_platform.extraction_candidates c ON c.tenant_id=r.tenant_id AND c.space_id=r.space_id AND c.candidate_id=$3::uuid
        WHERE r.${SCOPE.replaceAll(' AND ', ' AND r.')} AND r.project_id=$1::uuid AND r.record_id=$2::uuid AND r.revision=$4::bigint`,
      [source.projectRevisionRef.projectId, source.recordId, source.entityCandidateId, source.recordRevision],
    )
    if (values.rows[0]?.exact !== true) blocked()
  }
  for (const fence of [...fences].sort((a, b) => a.source.entityCandidateId.localeCompare(b.source.entityCandidateId))) {
    await assertConfirmation(query, fence)
  }
}

async function assertConfirmation(query: Query, fence: ProjectFactPublicationFence): Promise<void> {
  const source = fence.source
  const instance = await query.query<{ revision: string; matched_entity_id: string; identity_state: string; body: { fields: InstanceFieldValue[]; identity: { binding?: InstanceIdentityBinding } } }>(
    `SELECT revision::text,matched_entity_id,identity_state,body FROM agent_platform.instance_review_records WHERE ${SCOPE}
      AND project_id=$1::uuid AND record_id=$2::uuid ORDER BY revision DESC LIMIT 1 FOR SHARE`,
    [source.projectRevisionRef.projectId, source.entityCandidateId],
  )
  const candidate = await query.query<{ payload: { attributes: EntityCandidate['attributes']; objectId: string; identityScopeId: string }; source_spans: CandidateSourceSpan[]; state: string }>(
    `SELECT payload,source_spans,state FROM agent_platform.extraction_candidates WHERE ${SCOPE} AND candidate_id=$1::uuid FOR SHARE`, [source.entityCandidateId],
  )
  const reviewed = await query.query<{ decision: string; content_digest: string }>(
    `SELECT r.decision,r.content_digest FROM agent_platform.candidate_review_heads h
      JOIN agent_platform.semantic_candidate_reviews r USING (tenant_id,space_id,candidate_id,revision)
      WHERE h.${SCOPE.replaceAll(' AND ', ' AND h.')} AND h.candidate_id=$1::uuid FOR SHARE OF h`, [fence.candidateId],
  )
  const row = instance.rows[0]
  const attributes = candidate.rows[0]?.payload.attributes
  const binding = row?.body.identity.binding
  if (row?.revision !== fence.instanceRevision || row.matched_entity_id !== fence.entityId || !['matched','created'].includes(row.identity_state) || attributes === undefined || row.body.fields.length !== attributes.length ||
    binding?.candidateId !== source.entityCandidateId || binding.documentId !== source.documentId || binding.projectRevisionRef.projectId !== source.projectRevisionRef.projectId || binding.projectRevisionRef.revision !== source.projectRevisionRef.revision || binding.projectRevisionRef.digest !== source.projectRevisionRef.digest || !sameRef(binding.definitionRef, source.definitionRef) || binding.membershipRevision !== source.membershipRevision || binding.visibilityEpoch !== source.visibilityEpoch ||
    row.body.fields.some((field) => {
      const value = attributes.find((entry) => entry.attributeId === field.fieldId)
      const span = candidate.rows[0]?.source_spans[attributes.findIndex((entry) => entry.attributeId === field.fieldId)]
      return field.status !== 'confirmed' || field.actor === undefined || field.confirmedAt === undefined || value === undefined ||
        field.rawValue !== value.raw || span?.kind !== 'structured' || field.source.parseId !== span.parseId || field.source.textDigest !== span.rowDigest || JSON.stringify(field.source.locator) !== JSON.stringify(span.locator) ||
        (field.normalizedValue?.kind === 'quantity' ? field.normalizedValue.value !== value.value || field.normalizedValue.unitCode !== value.unitCode : field.normalizedValue?.kind !== 'scalar' || field.normalizedValue.value !== value.value)
    }) || reviewed.rows[0]?.decision !== 'approve' || reviewed.rows[0].content_digest !== fence.candidateDigest) blocked()
  await query.query(`SELECT revision FROM agent_platform.identity_decision_heads WHERE ${SCOPE} AND candidate_id=$1::uuid FOR SHARE`, [source.entityCandidateId])
  const entity = await query.query<{ object_id: string; identity_scope_id: string; state: string; project: string }>(
    `SELECT object_id,identity_scope_id,state,scope_dimensions->>'project' AS project FROM agent_platform.identity_entities WHERE ${SCOPE} AND entity_id=$1 FOR SHARE`, [fence.entityId],
  )
  const assertions = await query.query<{ entity_id: string }>(
    `SELECT entity_id FROM agent_platform.identity_assertions WHERE ${SCOPE} AND candidate_id=$1::uuid AND valid_to IS NULL LIMIT 2 FOR SHARE`, [source.entityCandidateId],
  )
  const negative = await query.query(`SELECT constraint_id FROM agent_platform.identity_link_constraints WHERE ${SCOPE} AND candidate_id=$1::uuid AND entity_id=$2 LIMIT 1 FOR SHARE`, [source.entityCandidateId, fence.entityId])
  if (entity.rows[0]?.state !== 'confirmed' || entity.rows[0].object_id !== candidate.rows[0]?.payload.objectId || entity.rows[0].identity_scope_id !== binding.identityScopeId || entity.rows[0].project !== source.projectRevisionRef.projectId || assertions.rows.length !== 1 || assertions.rows[0]?.entity_id !== fence.entityId || negative.rowCount > 0) blocked()
}
