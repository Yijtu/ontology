import type { QueryResultRow } from 'pg'
import { CandidateCommitError, assertCandidateRunBindingShape, isToolContext } from '@ontology/contracts'
import type {
  CandidateRunBinding,
  CandidateRunBindingPort,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'

interface BindingRow extends QueryResultRow {
  workspace_id: string
  draft_revision: string
  draft_digest: string
  document_set_ref: ResourceRef
  admission_state: string
}

/**
 * Resolves a research run's frozen binding from its durable admission (design §7, S08).
 *
 * The submit path must take its target workspace and its pinned draft from here, never from the
 * model's command and never from "the latest draft": a workspace-research run is frozen to the
 * exact draft revision it was admitted against, and the draft row pins that revision's digest and
 * document set. A run that is not an admitted (or not-yet-ready) research run resolves to
 * `undefined`, so the caller refuses the write instead of retargeting it.
 */
export class PostgresCandidateRunBindingStore implements CandidateRunBindingPort {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async resolve(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<CandidateRunBinding | undefined> {
    if (!isToolContext(ctx)) throw new CandidateCommitError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId
      || scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new CandidateCommitError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<BindingRow>(
        `SELECT admission.workspace_id, admission.draft_revision::text AS draft_revision,
                draft.digest AS draft_digest, draft.document_set_ref, admission.state AS admission_state
           FROM agent_platform.research_run_admission AS admission
           JOIN agent_platform.asset_draft_versions AS draft
             ON draft.tenant_id = admission.tenant_id AND draft.space_id = admission.space_id
            AND draft.workspace_id = admission.workspace_id AND draft.revision = admission.draft_revision
          WHERE admission.tenant_id = $1::uuid AND admission.space_id = $2::uuid
            AND admission.run_id = $3::uuid`,
        [scopeRef.tenantId, scopeRef.spaceId, runId],
      )
      const row = result.rows[0]
      if (row === undefined || row.admission_state !== 'ready') return undefined
      const binding = {
        runId,
        workspaceId: row.workspace_id,
        draftRevision: row.draft_revision,
        draftDigest: row.draft_digest as Sha256Digest,
        documentSetRef: row.document_set_ref,
      }
      assertCandidateRunBindingShape(binding)
      return binding
    }, { readOnly: true })
  }
}
