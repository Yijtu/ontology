import { assertRuleActionCandidateShape, assertRuleActionGenerationBatch, isToolContext, RuleActionCandidateStoreError } from '@ontology/contracts'
import type { RuleActionCandidateVersion, RuleActionGenerationBatch, RuleActionGenerationGuard,
  RuleActionGenerationStore, ScopeRef, ToolContext } from '@ontology/contracts'
import type { PoolClient } from 'pg'
import type { ControlPostgresDatabase } from './database'
import { PostgresRuleActionCandidateStore } from './rule-action-candidate-store'

function cancelled(guard: RuleActionGenerationGuard): void {
  if (guard.signal.aborted) throw new RuleActionCandidateStoreError('STORE_FAILED', 'generation cancelled before commit')
}
function assertScope(scope: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId || scope.tenantId !== ctx.allowedResources.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'generation requires a trusted matching scope')
}
function batchOf(value: unknown): RuleActionGenerationBatch { assertRuleActionGenerationBatch(value); return value }

/** Atomic operational generation on existing tables, sharing their workspace locks/RLS. */
export class PostgresRuleActionGenerationStore implements RuleActionGenerationStore {
  readonly #candidates: PostgresRuleActionCandidateStore
  constructor(readonly database: ControlPostgresDatabase) { this.#candidates = new PostgresRuleActionCandidateStore(database) }

  async #find(client: PoolClient, key: string): Promise<RuleActionGenerationBatch | undefined> {
    const result = await client.query<{ rule_action_result: unknown; generation_family: string }>(`SELECT rule_action_result,generation_family FROM agent_platform.asset_candidate_batches
      WHERE tenant_id = current_setting('app.tenant_id')::uuid AND space_id = current_setting('app.space_id')::uuid
        AND idempotency_key = $1`, [key])
    if (result.rows[0] !== undefined && result.rows[0].generation_family !== 'rule_action') throw new RuleActionCandidateStoreError('IDEMPOTENCY_CONFLICT', 'idempotency key belongs to a different generation family')
    return result.rows[0] === undefined ? undefined : batchOf(result.rows[0].rule_action_result)
  }
  find(scope: ScopeRef, key: string, ctx: ToolContext): Promise<RuleActionGenerationBatch | undefined> {
    assertScope(scope, ctx)
    return this.database.withIdentityScope(scope, (client) => this.#find(client, key))
  }
  getById(scope: ScopeRef, batchId: string, ctx: ToolContext): Promise<RuleActionGenerationBatch | undefined> {
    assertScope(scope, ctx)
    return this.database.withIdentityScope(scope, async (client) => {
      const result = await client.query<{ rule_action_result: unknown }>(`SELECT rule_action_result FROM agent_platform.asset_candidate_batches
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
          AND batch_id=$1 AND generation_family='rule_action'`, [batchId])
      return result.rows[0] === undefined ? undefined : batchOf(result.rows[0].rule_action_result)
    })
  }
  async commit(scope: ScopeRef, batch: RuleActionGenerationBatch, candidates: readonly RuleActionCandidateVersion[],
    guard: RuleActionGenerationGuard, ctx: ToolContext): Promise<{ batch: RuleActionGenerationBatch; candidates: readonly RuleActionCandidateVersion[]; created: boolean }> {
    assertScope(scope, ctx); assertRuleActionGenerationBatch(batch); candidates.forEach(assertRuleActionCandidateShape); cancelled(guard)
    if (candidates.length !== batch.candidateIds.length || candidates.some((candidate, index) => candidate.workspaceId !== batch.workspaceId || candidate.candidateId !== batch.candidateIds[index] || candidate.lifecycle !== 'draft' || candidate.generationContext?.batchId !== batch.batchId)) throw new RuleActionCandidateStoreError('INVALID_CANDIDATE', 'generated candidate set must exactly match its unapproved batch')
    const outcome = await this.database.withIdentityScope(scope, async (client) => {
      // All candidate/review writers use this same workspace lock (migration080).
      const workspace = await client.query<{ head_revision: string; state: string; latest_pack_ref: unknown }>(`SELECT head_revision,state,latest_pack_ref FROM agent_platform.industry_workspaces
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND workspace_id=$1 FOR UPDATE`, [batch.workspaceId])
      const prior = await this.#find(client, batch.idempotencyKey)
      if (prior !== undefined) {
        if (prior.requestDigest !== batch.requestDigest) throw new RuleActionCandidateStoreError('IDEMPOTENCY_CONFLICT', 'generation key changed input')
        return { batch: prior, created: false }
      }
      if (workspace.rows[0]?.head_revision !== guard.expectedWorkspaceRevision || workspace.rows[0].state === 'archived') throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'workspace moved during generation')
      const packPin = await client.query<{ matches: boolean }>('SELECT $1::jsonb IS NOT DISTINCT FROM $2::jsonb AS matches', [workspace.rows[0].latest_pack_ref === null ? null : JSON.stringify(workspace.rows[0].latest_pack_ref), guard.latestPublishedPackRef === undefined ? null : JSON.stringify(guard.latestPublishedPackRef)])
      if (packPin.rows[0]?.matches !== true) throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'mounted published pack changed during generation')
      const draft = await client.query<{ revision: string; digest: string; document_set_ref: unknown }>(`SELECT revision,digest,document_set_ref FROM agent_platform.asset_draft_versions
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND workspace_id=$1 ORDER BY revision DESC LIMIT 1`, [batch.workspaceId])
      const currentDraft = draft.rows[0]
      if (currentDraft?.revision !== guard.inputDraftRef.revision || currentDraft.digest !== guard.inputDraftRef.digest || JSON.stringify(currentDraft.document_set_ref) === undefined) throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'draft changed during generation')
      const corpus = await client.query<{ matches: boolean }>('SELECT $1::jsonb = $2::jsonb AS matches', [JSON.stringify(currentDraft.document_set_ref), JSON.stringify(guard.documentSetRef)])
      if (corpus.rows[0]?.matches !== true) throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'source corpus changed during generation')
      const defs = await client.query<{ matches: boolean }>(`SELECT jsonb_build_object('candidateId', c.candidate_id,'contentDigest',c.content_digest,'state',c.state,
        'inputDraftRef',c.input_draft_ref,'sourceRefs',c.source_refs,'sourceSpans',c.source_spans,'issues',c.issues,'pendingConfirmation',c.pending_confirmation)
        = ANY(ARRAY(SELECT value FROM jsonb_array_elements($2::jsonb))) AS matches FROM agent_platform.asset_candidate_versions c
        WHERE c.tenant_id=current_setting('app.tenant_id')::uuid AND c.space_id=current_setting('app.space_id')::uuid AND c.workspace_id=$1
        AND NOT EXISTS(SELECT 1 FROM agent_platform.asset_candidate_versions n WHERE n.tenant_id=c.tenant_id AND n.space_id=c.space_id AND n.workspace_id=c.workspace_id AND n.replaces_candidate_id=c.candidate_id)`, [batch.workspaceId, JSON.stringify(guard.definitionPins)])
      if (defs.rows.length !== guard.definitionPins.length || defs.rows.some((row) => !row.matches)) throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'definition projection changed during generation')
      const rules = await client.query<{ matches: boolean }>(`SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) p WHERE p->>'candidateId'=c.candidate_id::text
        AND p->>'contentDigest'=c.content_digest AND p->>'lifecycle'=c.lifecycle AND (p->>'enabledAt')::timestamptz IS NOT DISTINCT FROM c.enabled_at) AS matches
        FROM agent_platform.asset_rule_action_candidates c WHERE c.tenant_id=current_setting('app.tenant_id')::uuid AND c.space_id=current_setting('app.space_id')::uuid AND c.workspace_id=$1
        AND NOT EXISTS(SELECT 1 FROM agent_platform.asset_rule_action_candidates n WHERE n.tenant_id=c.tenant_id AND n.space_id=c.space_id AND n.workspace_id=c.workspace_id AND n.replaces_candidate_id=c.candidate_id)`, [batch.workspaceId, JSON.stringify(guard.ruleActionPins)])
      if (rules.rows.length !== guard.ruleActionPins.length || rules.rows.some((row) => !row.matches)) throw new RuleActionCandidateStoreError('VERSION_CONFLICT', 'rule/action projection changed during generation')
      cancelled(guard)
      await client.query(`INSERT INTO agent_platform.asset_candidate_batches(tenant_id,space_id,batch_id,workspace_id,input_draft_ref,model_ref,response_schema_ref,schema_digest,document_set_ref,generation_policy_ref,state,counts,error,idempotency_key,request_digest,created_by,recorded_at,generation_family,rule_action_result)
        VALUES(current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::timestamptz,'rule_action',$16::jsonb)`,
      [batch.batchId,batch.workspaceId,JSON.stringify(batch.inputDraftRef),JSON.stringify(batch.modelRef),JSON.stringify(batch.responseSchemaRef),batch.contextDigest,JSON.stringify(batch.documentSetRef),JSON.stringify(batch.generationPolicyRef),batch.state,JSON.stringify(batch.counts),batch.error===undefined?null:JSON.stringify(batch.error),batch.idempotencyKey,batch.requestDigest,batch.createdBy,batch.recordedAt,JSON.stringify(batch)])
      for (const candidate of candidates) {
        cancelled(guard)
        await client.query(`INSERT INTO agent_platform.asset_rule_action_candidates(tenant_id,space_id,candidate_id,workspace_id,logical_id,domain,kind,display_name,business_meaning,suggested_reason,payload,source_refs,source_spans,lifecycle,generation_call_ref,generation_context,content_digest,idempotency_key,actor,trace_id,recorded_at,replaces_candidate_id)
          SELECT current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,(j->>'candidateId')::uuid,(j->>'workspaceId')::uuid,j->>'logicalId','definition',j->>'kind',j->>'displayName',j->>'businessMeaning',j->>'suggestedReason',j->'payload',j->'sourceRefs',j->'sourceSpans','draft',j->'generationCallRef',j->'generationContext',j->>'contentDigest',j->>'idempotencyKey',j->>'actor',$2,(j->>'recordedAt')::timestamptz,(j->>'replacesCandidateId')::uuid FROM (SELECT $1::jsonb AS j) input`, [JSON.stringify(candidate),ctx.traceId])
      }
      cancelled(guard)
      return { batch, created: true }
    })
    cancelled(guard)
    const rows: RuleActionCandidateVersion[] = []
    for (const id of outcome.batch.candidateIds) {
      const row = await this.#candidates.get(scope, id, ctx)
      if (row === undefined) throw new RuleActionCandidateStoreError('STORE_FAILED', 'generation candidate is missing')
      rows.push(row)
    }
    cancelled(guard)
    return { ...outcome, candidates: rows }
  }
}
