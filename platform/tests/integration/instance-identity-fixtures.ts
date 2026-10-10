import { randomUUID, createHash } from 'node:crypto'
import type { Client } from 'pg'
import type { ResolvedProfileRef, ScopeRef, VersionRef } from '@ontology/contracts'

const DIGEST = `sha256:${'a'.repeat(64)}`

/** Seed the same immutable pins production reads; fixture data never travels in the HTTP body. */
export async function seedIdentityProject(admin: Client, scope: ScopeRef, projectId: string, definitionRef: VersionRef, identityMappingRef: VersionRef = definitionRef,
  pins?: { readonly industryPackRef: VersionRef; readonly profileRef: ResolvedProfileRef }): Promise<void> {
  await admin.query(
    `INSERT INTO agent_platform.projects
      (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'Identity project',1,'draft',$4,$5,'fixture',now(),now())`,
    [scope.tenantId, scope.spaceId, projectId, randomUUID(), DIGEST],
  )
  const body = {
    schemaVersion: 'project-revision@1', projectId, revision: '1', industryPackRef: pins?.industryPackRef ?? definitionRef, definitionRef,
    mappingRefs: [{ ...identityMappingRef, role: 'identity', sourceObjectRef: { sourceRef: { namespace: 'fixture', sourceId: 'identity' }, objectPath: 'identity_index' } }],
    profileRef: pins?.profileRef ?? { id: 'fixture', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    semanticPublicationRefs: [], sourceVisibilityEpoch: '0', changeReason: 'identity fixture',
  }
  await admin.query(
    `INSERT INTO agent_platform.project_revisions (tenant_id,space_id,project_id,revision,digest,body,source_visibility_epoch,change_reason,idempotency_key,request_digest,actor,recorded_at)
     VALUES ($1,$2,$3,1,$4,$5::jsonb,0,'identity fixture',$6,$4,'fixture',now())`,
    [scope.tenantId, scope.spaceId, projectId, DIGEST, JSON.stringify(body), randomUUID()],
  )
}

export async function seedIdentityParse(admin: Client, scope: ScopeRef, parseId: string): Promise<void> {
  await admin.query(
    `INSERT INTO agent_platform.document_parse_runs (
      tenant_id,space_id,parse_id,original_blob_ref_id,original_content_digest,original_media_type,original_kind,media_kind,
      parser_id,parser_version,offset_unit,parse_status,completeness,coverage,normalized_blob_ref_id,normalized_content_digest,
      normalized_media_type,normalized_byte_size,span_map_blob_ref_id,span_map_content_digest,span_map_media_type)
     VALUES ($1,$2,$3,$4,$5,'text/plain','document','text','fixture','1.0.0','character','complete','complete','{}'::jsonb,$6,$5,'text/plain',0,$7,$5,'text/plain')`,
    [scope.tenantId, scope.spaceId, parseId, randomUUID(), `sha256:${createHash('sha256').update(parseId).digest('hex')}`, randomUUID(), randomUUID()],
  )
}
