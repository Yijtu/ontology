import { IdentityDecisionStoreError, InstanceReviewError } from '@ontology/contracts'
import type { AppendInstanceRecordInput, IdentityDecisionProjectFence, Uuid, VersionRef } from '@ontology/contracts'
import type { QueryResultRow } from 'pg'

interface ScopedProjectFenceQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

/** Freeze the authoritative binding until an approval/publication revision commits. */
export async function assertPublishedInstanceBinding(query: ScopedProjectFenceQuery, projectId: Uuid, input: AppendInstanceRecordInput): Promise<void> {
  const binding = input.identityBinding
  const entityId = input.matchedEntityId
  if (binding === undefined || entityId === undefined || (input.identityState !== 'matched' && input.identityState !== 'created')) {
    throw new InstanceReviewError('IDENTITY_CONFLICT', 'approval/publication requires a trusted human identity binding')
  }
  // Every decision locks its candidate head before its target entity. Following the same
  // order also protects a membership closed by a split initiated from another candidate.
  const head = await query.query<{ revision: string }>(
    `SELECT revision::text AS revision FROM agent_platform.identity_decision_heads
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND candidate_id=$1::uuid FOR SHARE`, [binding.candidateId],
  )
  const entity = await query.query<{ object_id: string; identity_scope_id: string; state: string; scope_dimensions: Record<string, string> }>(
    `SELECT object_id,identity_scope_id,state,scope_dimensions FROM agent_platform.identity_entities
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND entity_id=$1 FOR SHARE`, [entityId],
  )
  const assertions = await query.query<{ entity_id: string; object_id: string; identity_scope_id: string }>(
    `SELECT entity_id,object_id,identity_scope_id FROM agent_platform.identity_assertions
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND candidate_id=$1::uuid AND valid_to IS NULL LIMIT 2 FOR SHARE`, [binding.candidateId],
  )
  const negative = await query.query<{ constraint_id: string }>(
    `SELECT constraint_id FROM agent_platform.identity_link_constraints
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND candidate_id=$1::uuid AND entity_id=$2 AND kind='cannot_link' LIMIT 1 FOR SHARE`, [binding.candidateId, entityId],
  )
  const current = entity.rows[0]
  const assertion = assertions.rows[0]
  if (head.rows[0] === undefined || current?.state !== 'confirmed' || current.object_id !== input.objectTypeRef || current.identity_scope_id !== binding.identityScopeId || current.scope_dimensions['project'] !== projectId ||
    assertions.rows.length !== 1 || assertion?.entity_id !== entityId || assertion.object_id !== input.objectTypeRef || assertion.identity_scope_id !== binding.identityScopeId || negative.rows.length > 0) {
    throw new InstanceReviewError('IDENTITY_CONFLICT', 'the authoritative human identity binding changed before approval/publication commit')
  }
}

/** Shared commit guard for authoritative identity decisions and the instance revision they expose. */
export async function assertIdentityProjectFence(query: ScopedProjectFenceQuery, fence: IdentityDecisionProjectFence): Promise<void> {
  const projectId = fence.projectRevisionRef.projectId
  // Lock in the same membership→visibility order as document withdrawal. A project
  // head update or corpus epoch advance cannot pass this decision's commit point.
  const project = await query.query<{ head_revision: string; state: string }>(
    `SELECT head_revision::text AS head_revision, state FROM agent_platform.projects
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND project_id=$1::uuid FOR SHARE`, [projectId],
  )
  const revision = await query.query<{ digest: string; definition_ref: VersionRef }>(
    `SELECT digest, body->'definitionRef' AS definition_ref FROM agent_platform.project_revisions
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND project_id=$1::uuid AND revision=$2::bigint`, [projectId, fence.projectRevisionRef.revision],
  )
  const membership = await query.query<{ membership_revision: string; state: string; parse_id: string }>(
    `SELECT membership_revision::text AS membership_revision,state,parse_id FROM agent_platform.project_document_memberships
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND project_id=$1::uuid AND document_id=$2::uuid
      ORDER BY membership_revision DESC LIMIT 1 FOR SHARE`, [projectId, fence.documentId],
  )
  const visibility = await query.query<{ epoch: string }>(
    `SELECT visibility_epoch::text AS epoch FROM agent_platform.project_visibility
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
        AND project_id=$1::uuid FOR SHARE`, [projectId],
  )
  const definition = revision.rows[0]?.definition_ref
  if (project.rows[0]?.head_revision !== fence.projectRevisionRef.revision || project.rows[0]?.state === 'archived' ||
    revision.rows[0]?.digest !== fence.projectRevisionRef.digest || definition?.id !== fence.definitionRef.id || definition.version !== fence.definitionRef.version || definition.digest !== fence.definitionRef.digest ||
    membership.rows[0]?.state !== 'active' || membership.rows[0]?.membership_revision !== fence.membershipRevision || membership.rows[0]?.parse_id !== fence.parseId || visibility.rows[0]?.epoch !== fence.visibilityEpoch) {
    throw new IdentityDecisionStoreError('PROJECT_FENCE_STALE', 'project definition, source membership or visibility changed before identity commit')
  }
}
