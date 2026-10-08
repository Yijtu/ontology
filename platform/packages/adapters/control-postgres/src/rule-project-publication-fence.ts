import { SemanticPublicationStoreError } from '@ontology/contracts'
import type { PublishSemanticPublicationInput, VersionRef } from '@ontology/contracts'
import type { QueryResultRow } from 'pg'

interface Query {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}
const SCOPE = `tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid`
const sameRef = (a: VersionRef, b: VersionRef): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest
function blocked(): never { throw new SemanticPublicationStoreError('IDENTITY_CONSTRAINT_BLOCKED', 'tagged rule project revision, reviewed content or definition changed before publication') }

/** The stored candidate chooses its tagged project; a direct store caller cannot add/drop that authority. */
export async function assertRuleProjectPublicationFences(query: Query, input: PublishSemanticPublicationInput): Promise<void> {
  const candidates = await query.query<{ candidate_id: string; project_id: string }>(
    `SELECT candidate_id,payload->>'projectId' AS project_id FROM agent_platform.extraction_candidates
     WHERE ${SCOPE} AND kind='rule' AND candidate_id=ANY($1::uuid[]) AND payload ? 'projectId' ORDER BY candidate_id`,
    [input.publication.ruleVersions.map((rule) => rule.sourceCandidateId)],
  )
  const pins = input.ruleProjectPins ?? [], savedPins = input.publication.ruleProjectPins ?? []
  const declared = input.publication.ruleVersions.filter((rule) => rule.projectId !== undefined)
  if (declared.length !== candidates.rows.length || declared.some((rule) => !candidates.rows.some((candidate) => candidate.candidate_id === rule.sourceCandidateId && candidate.project_id === rule.projectId)) ||
    pins.length !== candidates.rows.length || new Set(pins.map((pin) => pin.candidateId)).size !== pins.length || savedPins.length !== pins.length ||
    pins.some((pin) => !savedPins.some((saved) => saved.candidateId === pin.candidateId && saved.candidateDigest === pin.candidateDigest && saved.reviewRevision === pin.reviewRevision &&
      saved.projectRevisionRef.projectId === pin.projectRevisionRef.projectId && saved.projectRevisionRef.revision === pin.projectRevisionRef.revision && saved.projectRevisionRef.digest === pin.projectRevisionRef.digest && sameRef(saved.definitionRef, pin.definitionRef)))) blocked()
  for (const projectId of [...new Set(pins.map((pin) => pin.projectRevisionRef.projectId))].sort()) {
    await query.query(`SELECT 1 FROM agent_platform.projects WHERE ${SCOPE} AND project_id=$1::uuid FOR SHARE`, [projectId])
  }
  for (const candidate of candidates.rows) {
    const pin = pins.find((entry) => entry.candidateId === candidate.candidate_id), rule = input.publication.ruleVersions.find((entry) => entry.sourceCandidateId === candidate.candidate_id)
    if (pin === undefined || rule === undefined || rule.ruleVersionId !== candidate.candidate_id || pin.projectRevisionRef.projectId !== candidate.project_id || rule.projectId !== candidate.project_id || !sameRef(pin.definitionRef, input.publication.schemaRef) ||
      !input.publication.approvedCandidateRefs.some((ref) => ref.candidateId === candidate.candidate_id && ref.kind === 'rule')) blocked()
    const project = await query.query<{ head_revision: string; state: string; digest: string; definition_ref: VersionRef }>(
      `SELECT p.head_revision::text AS head_revision,p.state,r.digest,r.body->'definitionRef' AS definition_ref
       FROM agent_platform.projects p JOIN agent_platform.project_revisions r ON r.tenant_id=p.tenant_id AND r.space_id=p.space_id AND r.project_id=p.project_id AND r.revision=p.head_revision
       WHERE p.tenant_id=current_setting('app.tenant_id')::uuid AND p.space_id=current_setting('app.space_id')::uuid AND p.project_id=$1::uuid`, [candidate.project_id],
    )
    const current = project.rows[0]
    if (current === undefined || current.state === 'archived' || current.head_revision !== pin.projectRevisionRef.revision || current.digest !== pin.projectRevisionRef.digest || !sameRef(current.definition_ref, pin.definitionRef)) blocked()
    await query.query(`SELECT 1 FROM agent_platform.extraction_candidates WHERE ${SCOPE} AND candidate_id=$1::uuid FOR SHARE`, [candidate.candidate_id])
    await query.query(`SELECT 1 FROM agent_platform.candidate_review_heads WHERE ${SCOPE} AND candidate_id=$1::uuid FOR SHARE`, [candidate.candidate_id])
    const exact = await query.query<{ exact: boolean }>(
      `SELECT c.state='pending_review' AND c.idempotency_key=$2 AND c.definition_ref=$3::jsonb AND c.payload->>'projectId'=$4
        AND c.payload->>'ruleId'=$5 AND c.payload->>'objectId'=$6 AND c.payload->'expression'=$7::jsonb AND c.payload->'exceptions'=$8::jsonb
        AND COALESCE(c.payload->'ruleDependencies','[]'::jsonb)=$9::jsonb AND COALESCE(c.payload->'dependencyRefs','[]'::jsonb)=$10::jsonb
        AND h.revision=$11::bigint AND r.decision='approve' AND r.content_digest=c.idempotency_key
        AND (c.payload->'conclusion' IS NOT DISTINCT FROM $12::jsonb OR
          c.payload#>>'{conclusion,predicate}'=$12::jsonb->>'predicate' AND
          jsonb_typeof(c.payload#>'{conclusion,value}')='object' AND jsonb_typeof($12::jsonb->'value')='object' AND
          c.payload#>>'{conclusion,value,kind}' IS NOT DISTINCT FROM $12::jsonb#>>'{value,kind}' AND
          c.payload#>>'{conclusion,value,unit}' IS NOT DISTINCT FROM $12::jsonb#>>'{value,unit}' AND
          CASE WHEN c.payload#>>'{conclusion,value,amount}' ~ '^-?[0-9]+(\\.[0-9]+)?$' AND $12::jsonb#>>'{value,amount}' ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (c.payload#>>'{conclusion,value,amount}')::numeric=($12::jsonb#>>'{value,amount}')::numeric ELSE false END) AS exact
       FROM agent_platform.extraction_candidates c JOIN agent_platform.candidate_review_heads h ON h.tenant_id=c.tenant_id AND h.space_id=c.space_id AND h.candidate_id=c.candidate_id
       JOIN agent_platform.semantic_candidate_reviews r ON r.tenant_id=h.tenant_id AND r.space_id=h.space_id AND r.candidate_id=h.candidate_id AND r.revision=h.revision
       WHERE c.tenant_id=current_setting('app.tenant_id')::uuid AND c.space_id=current_setting('app.space_id')::uuid AND c.candidate_id=$1::uuid`,
      [candidate.candidate_id, pin.candidateDigest, JSON.stringify(pin.definitionRef), candidate.project_id, rule.ruleId, rule.objectId, JSON.stringify(rule.expression), JSON.stringify(rule.exceptions),
        JSON.stringify(rule.ruleDependencies ?? []), JSON.stringify(rule.dependencyRefs ?? []), pin.reviewRevision, rule.conclusion === undefined ? null : JSON.stringify(rule.conclusion)],
    )
    if (exact.rows[0]?.exact !== true) blocked()
  }
}
