import type { QueryResultRow } from 'pg'
import {
  COMPETENCY_BODY_MEDIA_TYPE,
  PublishedPackAssetStoreError,
  assertPublishedPackAssetShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  IndustryValidationReport,
  CommitApprovedPackInput,
  CommitApprovedPackResult,
  NewOutboxMessage,
  PublishedPackAsset,
  PublishedPackAssetFilter,
  PublishedPackAssetStore,
  ScopeRef,
  SemanticDefinitionAudit,
  SemanticDefinitionRecord,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface AssetRow extends QueryResultRow {
  content_digest: string
  request_digest: string
  asset: PublishedPackAsset
}

interface DigestRow extends QueryResultRow {
  digest: string
}

const ASSET_COLUMNS = 'content_digest, request_digest, asset'

function toAsset(row: AssetRow): PublishedPackAsset {
  assertPublishedPackAssetShape(row.asset)
  return row.asset
}

/**
 * Real PostgreSQL implementation of the published-pack store and dynamic catalogue source
 * (SPEC v0.3a §4.2/§6.1, migration 066).
 *
 * `commitApprovedPack` is the single publication transaction: it locks the workspace head, fixes
 * the definition version and its audit event, writes the immutable pack asset, advances the
 * workspace publish pointer and enqueues the outbox message. Replaying the same idempotency key
 * returns the stored asset; the same key with a different request is an `IDEMPOTENCY_CONFLICT`. A
 * pack id/version or a namespace/version published with a different digest is refused.
 */
export class PostgresPublishedPackAssetStore implements PublishedPackAssetStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async commitApprovedPack(
    scopeRef: ScopeRef,
    input: CommitApprovedPackInput,
    ctx: ToolContext,
  ): Promise<CommitApprovedPackResult> {
    const pack = input.pack
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#byIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== input.requestDigest) {
          throw new PublishedPackAssetStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different publication request',
          )
        }
        return { asset: toAsset(replay), created: false }
      }

      const locked = await query.query<{ head_revision: string }>(
        `SELECT head_revision FROM agent_platform.industry_workspaces
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND workspace_id = $1::uuid
           FOR UPDATE`,
        [pack.workspaceId],
      )
      const workspaceRow = locked.rows[0]
      if (workspaceRow === undefined) {
        throw new PublishedPackAssetStoreError(
          'WORKSPACE_NOT_FOUND',
          `workspace ${pack.workspaceId} is not visible in the requested scope`,
        )
      }
      if (workspaceRow.head_revision !== input.expectedRevision) {
        throw new PublishedPackAssetStoreError(
          'VERSION_CONFLICT',
          `workspace head is ${workspaceRow.head_revision}, not the expected ${input.expectedRevision}`,
        )
      }
      await this.#guardPublicationPins(query, input)

      const existingPack = await this.#byPackIdVersion(query, pack.packRef.id, pack.packRef.version)
      if (existingPack !== undefined) {
        if (existingPack.content_digest === pack.contentDigest) return { asset: toAsset(existingPack), created: false }
        throw new PublishedPackAssetStoreError(
          'PACK_VERSION_EXISTS',
          `pack ${pack.packRef.id}@${pack.packRef.version} is already published with a different digest`,
        )
      }
      const namespacePeer = await this.#byNamespaceVersion(query, pack.namespace, pack.packRef.version)
      if (namespacePeer !== undefined) {
        if (namespacePeer.content_digest === pack.contentDigest) return { asset: toAsset(namespacePeer), created: false }
        throw new PublishedPackAssetStoreError(
          'NAMESPACE_CONFLICT',
          `namespace ${pack.namespace} already publishes version ${pack.packRef.version} with a different digest`,
        )
      }

      const revision = (BigInt(workspaceRow.head_revision) + 1n).toString()
      await this.#insertDefinition(query, input.definition)
      await this.#insertDefinitionEvent(query, input.definition, input.definitionAudit)
      const asset: PublishedPackAsset = { ...pack, revision, publishedAt: input.recordedAt }
      assertPublishedPackAssetShape(asset)
      await this.#insertAsset(query, asset, input)
      await query.query(
        `UPDATE agent_platform.industry_workspaces
            SET head_revision = $2::bigint, latest_pack_ref = $3::jsonb, state = 'published', updated_at = $4::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid`,
        [pack.workspaceId, revision, JSON.stringify(asset.packRef), input.recordedAt],
      )
      await this.#insertJob(query, asset, input)
      await this.#insertOutbox(query, input.outboxJobId, input.outbox)
      return { asset, created: true }
    })
  }

  async findPack(
    scopeRef: ScopeRef,
    packId: string,
    version: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byPackIdVersion(query, packId, version)
      return row === undefined ? undefined : toAsset(row)
    })
  }

  async findByRef(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<PublishedPackAsset | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AssetRow>(
        `SELECT ${ASSET_COLUMNS} FROM agent_platform.published_pack_assets
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND pack_id = $1 AND version = $2 AND content_digest = $3`,
        [ref.id, ref.version, ref.digest],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toAsset(row)
    })
  }

  async listPacks(
    scopeRef: ScopeRef,
    filter: PublishedPackAssetFilter,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset[]> {
    const limit = normalizeLimit(filter.limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AssetRow>(
        `SELECT ${ASSET_COLUMNS} FROM agent_platform.published_pack_assets
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND ($1::text IS NULL OR namespace = $1)
           ORDER BY published_at, pack_id, version
           LIMIT $2`,
        [filter.namespace ?? null, limit],
      )
      return result.rows.map(toAsset)
    })
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byIdempotencyKey(query, key)
      return row === undefined ? undefined : toAsset(row)
    })
  }

  async #guardPublicationPins(query: ScopedQuery, input: CommitApprovedPackInput): Promise<void> {
    await this.#guardCompetency(query, input)
    const rows = await query.query<{ candidate_id: string; content_digest: string; state: string; pending_confirmation: boolean;
      review_revision: string | null; decision: string | null; reviewed_digest: string | null }>(
      `SELECT c.candidate_id, c.content_digest, c.state, c.pending_confirmation,
              h.revision::text AS review_revision, r.decision, r.content_digest AS reviewed_digest
         FROM agent_platform.asset_candidate_versions c
         LEFT JOIN agent_platform.candidate_review_heads h
           ON h.tenant_id = c.tenant_id AND h.space_id = c.space_id AND h.candidate_id = c.candidate_id
         LEFT JOIN agent_platform.semantic_candidate_reviews r
           ON r.tenant_id = h.tenant_id AND r.space_id = h.space_id AND r.candidate_id = h.candidate_id AND r.revision = h.revision
        WHERE c.tenant_id = current_setting('app.tenant_id')::uuid AND c.space_id = current_setting('app.space_id')::uuid
          AND c.workspace_id = $1::uuid AND c.state <> 'rejected'
          AND NOT EXISTS (SELECT 1 FROM agent_platform.asset_candidate_versions replacement
            WHERE replacement.tenant_id = c.tenant_id AND replacement.space_id = c.space_id
              AND replacement.workspace_id = c.workspace_id AND replacement.replaces_candidate_id = c.candidate_id)`,
      [input.pack.workspaceId],
    )
    const pins = input.approvalPins ?? []
    const persistedPins = input.pack.approvalPins ?? []
    if (persistedPins.length !== pins.length || pins.some((pin) => !persistedPins.some((stored) => stored.candidateId === pin.candidateId &&
        stored.contentDigest === pin.contentDigest && stored.reviewRevision === pin.reviewRevision))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'the immutable pack must retain its exact approval pins')
    }
    if (pins.length !== rows.rows.length || pins.length !== new Set(pins.map((pin) => pin.candidateId)).size ||
        (input.definition.objects.length + input.definition.attributes.length + input.definition.relations.length !== pins.length) ||
        rows.rows.some((row) => !pins.some((pin) => pin.candidateId === row.candidate_id && pin.contentDigest === row.content_digest &&
          pin.reviewRevision === row.review_revision && row.decision === 'approve' && row.reviewed_digest === row.content_digest &&
          row.state !== 'failed' && row.state !== 'pending_confirmation' && !row.pending_confirmation))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'definition approval or current candidate pins changed before publication')
    }
    const sourceDraft = await query.query<{ revision: string; digest: string }>(`SELECT revision,digest FROM agent_platform.asset_draft_versions
      WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND workspace_id=$1 ORDER BY revision DESC LIMIT 1`, [input.pack.workspaceId])
    const actions = await query.query<{ candidate_id: string; content_digest: string; enabled_at: Date; kind: string; grounded: boolean }>(
      `SELECT candidate_id, content_digest, enabled_at, kind,
         (generation_context IS NULL OR (jsonb_array_length(generation_context->'issues')=0 AND jsonb_array_length(source_spans)>0
           AND generation_context->'inputDraftRef'->>'workspaceId'=$1::text
           AND generation_context->'inputDraftRef'->>'revision'=$2
           AND generation_context->'inputDraftRef'->>'digest'=$3)) AS grounded FROM (
         SELECT DISTINCT ON (c.logical_id) c.logical_id, c.candidate_id, c.content_digest, c.lifecycle, c.enabled_at, c.kind, c.generation_context, c.source_spans
         FROM agent_platform.asset_rule_action_candidates c
         WHERE c.tenant_id = current_setting('app.tenant_id')::uuid AND c.space_id = current_setting('app.space_id')::uuid
           AND c.workspace_id = $1::uuid AND NOT EXISTS (
             SELECT 1 FROM agent_platform.asset_rule_action_candidates replacement
             WHERE replacement.tenant_id = c.tenant_id AND replacement.space_id = c.space_id
               AND replacement.workspace_id = c.workspace_id AND replacement.replaces_candidate_id = c.candidate_id)
         ORDER BY c.logical_id, c.recorded_at DESC, c.candidate_id DESC
       ) current_candidates WHERE lifecycle = 'enabled' AND enabled_at IS NOT NULL`,
      [input.pack.workspaceId,sourceDraft.rows[0]?.revision ?? null,sourceDraft.rows[0]?.digest ?? null],
    )
    const actionPins = input.ruleActionPins ?? []
    if (actions.rows.some((row) => row.grounded !== true)) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'generated rule/action sources are not confirmed at publication commit')
    const persistedActions = input.pack.ruleActionPins ?? []
    if (persistedActions.length !== actionPins.length || actionPins.some((pin) => !persistedActions.some((stored) => stored.candidateId === pin.candidateId &&
        stored.contentDigest === pin.contentDigest && stored.enabledAt === pin.enabledAt))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'the immutable pack must retain its exact enablement pins')
    }
    if (actionPins.length !== actions.rows.length || actionPins.length !== new Set(actionPins.map((pin) => pin.candidateId)).size ||
        actions.rows.some((row) => !actionPins.some((pin) => pin.candidateId === row.candidate_id && pin.contentDigest === row.content_digest &&
          Date.parse(pin.enabledAt) === row.enabled_at.getTime()))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'enabled rule/action pins changed before publication')
    }
    const declarations = input.pack.ruleDeclarations ?? []
    const rulePins = input.ruleReviewPins ?? []
    const persistedRulePins = input.pack.ruleReviewPins ?? []
    if (declarations.length !== actions.rows.filter((row) => row.kind === 'rule').length || rulePins.length !== declarations.length || persistedRulePins.length !== rulePins.length ||
      new Set(declarations.map((row) => row.candidateId)).size !== declarations.length || rulePins.some((pin) => !persistedRulePins.some((stored) =>
        stored.candidateId === pin.candidateId && stored.contentDigest === pin.contentDigest && stored.reviewRevision === pin.reviewRevision))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'published rule bodies must retain all current reviewed enablement pins')
    }
    for (const declaration of declarations) {
      const pin = rulePins.find((row) => row.candidateId === declaration.candidateId && row.contentDigest === declaration.contentDigest && row.reviewRevision === declaration.reviewRevision)
      const valid = pin === undefined ? undefined : await query.query<{ candidate_id: string }>(
        `SELECT c.candidate_id FROM agent_platform.asset_rule_action_candidates c
         JOIN agent_platform.candidate_review_heads h ON h.tenant_id=c.tenant_id AND h.space_id=c.space_id AND h.candidate_id=c.candidate_id
         JOIN agent_platform.semantic_candidate_reviews r ON r.tenant_id=h.tenant_id AND r.space_id=h.space_id AND r.candidate_id=h.candidate_id AND r.revision=h.revision
         WHERE c.tenant_id=current_setting('app.tenant_id')::uuid AND c.space_id=current_setting('app.space_id')::uuid
           AND c.candidate_id=$1::uuid AND c.kind='rule' AND c.lifecycle='enabled' AND c.content_digest=$2
           AND c.enabled_at=$3::timestamptz AND h.revision=$4::bigint AND r.decision='approve' AND r.content_digest=c.content_digest
           AND c.payload=$5::jsonb AND c.source_refs=$6::jsonb AND c.source_spans=$7::jsonb
           AND c.generation_call_ref IS NOT DISTINCT FROM $8::jsonb
           AND c.generation_context IS NOT DISTINCT FROM $9::jsonb
           AND (c.generation_context IS NULL OR (jsonb_array_length(c.generation_context->'issues')=0 AND jsonb_array_length(c.source_spans)>0))`,
        [declaration.candidateId, declaration.contentDigest, declaration.enabledAt, declaration.reviewRevision, JSON.stringify(declaration.payload),
          JSON.stringify(declaration.sourceRefs), JSON.stringify(declaration.sourceSpans), declaration.generationCallRef === undefined ? null : JSON.stringify(declaration.generationCallRef),
          declaration.generationContext === undefined ? null : JSON.stringify(declaration.generationContext)],
      )
      if (valid?.rows.length !== 1) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'rule approval, provenance or complete body changed before publication')
    }
  }

  async #guardCompetency(query: ScopedQuery, input: CommitApprovedPackInput): Promise<void> {
    const cases = input.pack.packAsset.testSuite.cases
    const validation = await query.query<{ report: IndustryValidationReport; content_digest: string }>(
      `SELECT report, content_digest FROM agent_platform.industry_validation_reports
       WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
         AND validation_id=$1::uuid AND workspace_id=$2::uuid AND revision=$3::bigint`,
      [input.pack.validationRef.id, input.pack.workspaceId, input.expectedRevision],
    )
    const stored = validation.rows[0]
    const competency = stored?.report.competency
    if (competency === undefined) {
      if (stored?.report.competencyRequired === true && input.pack.capabilities.deploymentExecutable) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'required competency validation is not deployment-executable')
      if (cases.some((item) => item.competencyQuestionRef !== undefined)) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'competency suite has no actual scoped validation')
      return
    }
    const target = competency.validationTarget
    const targetPins = target?.definitionApprovalPins ?? []
    const targetRules = target?.ruleActionPins ?? []
    if (stored?.content_digest !== input.pack.validationRef.digest || target?.workspaceId !== input.pack.workspaceId || target.revision !== input.expectedRevision ||
        targetPins.length !== (input.approvalPins ?? []).length || targetPins.some((pin) => !(input.approvalPins ?? []).some((other) => other.candidateId === pin.candidateId && other.contentDigest === pin.contentDigest && other.reviewRevision === pin.reviewRevision)) ||
        targetRules.length !== (input.ruleActionPins ?? []).length || targetRules.some((pin) => !(input.ruleActionPins ?? []).some((other) => other.candidateId === pin.candidateId && other.contentDigest === pin.contentDigest && other.enabledAt === pin.enabledAt)) ||
        cases.length !== competency.results.length || competency.results.some((result) => !cases.some((item) => item.caseId === result.questionId && item.question === result.question && item.expectedStatus === result.status &&
          item.competencyQuestionRef?.id === competency.questionSetRef.id && item.competencyQuestionRef.version === competency.questionSetRef.version && item.competencyQuestionRef.digest === competency.questionSetRef.digest)) ||
        (input.pack.capabilities.deploymentExecutable && (!competency.passed || competency.results.some((result) => result.status !== 'passed')))) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'competency validation does not pin the complete actual reviewed draft and suite')
    }
    const approved = await query.query<{ candidate_id: string }>(
      `SELECT h.candidate_id FROM agent_platform.candidate_review_heads h
       JOIN agent_platform.semantic_candidate_reviews r ON r.tenant_id=h.tenant_id AND r.space_id=h.space_id AND r.candidate_id=h.candidate_id AND r.revision=h.revision
       JOIN agent_platform.artifact_references a ON a.tenant_id=h.tenant_id AND a.space_id=h.space_id AND a.blob_ref_id=h.candidate_id
       JOIN agent_platform.artifact_blobs b ON b.tenant_id=a.tenant_id AND b.space_id=a.space_id AND b.content_digest=a.content_digest
       WHERE h.tenant_id=current_setting('app.tenant_id')::uuid AND h.space_id=current_setting('app.space_id')::uuid AND h.candidate_id=$1::uuid
         AND r.decision='approve' AND r.content_digest=$2 AND a.content_digest=$2 AND a.purpose='artifact' AND b.media_type=$3 AND b.byte_size<=1048576
       FOR UPDATE OF h,r`,
      [competency.questionSetRef.id, competency.questionSetRef.digest, COMPETENCY_BODY_MEDIA_TYPE],
    )
    if (approved.rows.length !== 1) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'competency approval or body artifact changed before publication commit')
  }

  async #insertDefinition(query: ScopedQuery, definition: SemanticDefinitionRecord): Promise<void> {
    const inserted = await query.query(
      `INSERT INTO agent_platform.semantic_definition_versions
         (tenant_id, space_id, namespace, definition_id, version, digest, layer, definition, published_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING digest`,
      [
        definition.namespace,
        definition.ref.id,
        definition.ref.version,
        definition.ref.digest,
        definition.layer,
        JSON.stringify(definition),
        definition.publishedAt,
      ],
    )
    if (inserted.rowCount > 0) return
    const existing = await query.query<DigestRow>(
      `SELECT digest FROM agent_platform.semantic_definition_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND namespace = $1 AND definition_id = $2 AND version = $3`,
      [definition.namespace, definition.ref.id, definition.ref.version],
    )
    if (existing.rows[0]?.digest !== definition.ref.digest) {
      throw new PublishedPackAssetStoreError(
        'DEFINITION_VERSION_EXISTS',
        `definition ${definition.ref.id}@${definition.ref.version} is already published with a different digest`,
      )
    }
  }

  async #insertDefinitionEvent(
    query: ScopedQuery,
    definition: SemanticDefinitionRecord,
    audit: SemanticDefinitionAudit,
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.semantic_definition_events
         (tenant_id, space_id, namespace, definition_id, version, seq, digest, payload_digest,
          idempotency_key, actor, occurred_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3,
         (SELECT coalesce(max(seq), 0) + 1
            FROM agent_platform.semantic_definition_events
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND namespace = $1 AND definition_id = $2 AND version = $3),
         $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        definition.namespace,
        definition.ref.id,
        definition.ref.version,
        audit.digest,
        audit.payloadDigest,
        audit.idempotencyKey,
        audit.actor,
        audit.occurredAt,
      ],
    )
  }

  async #insertAsset(
    query: ScopedQuery,
    asset: PublishedPackAsset,
    input: CommitApprovedPackInput,
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.published_pack_assets
         (tenant_id, space_id, pack_id, version, namespace, maturity, definition_id, definition_version,
          definition_digest, content_digest, revision, origin_workspace_id, asset, idempotency_key,
          request_digest, actor, trace_id, published_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::uuid, $11::jsonb, $12, $13, $14,
         current_setting('app.trace_id', true), $15::timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        asset.packRef.id,
        asset.packRef.version,
        asset.namespace,
        asset.maturity,
        asset.definitionRef.id,
        asset.definitionRef.version,
        asset.definitionRef.digest,
        asset.contentDigest,
        asset.revision,
        asset.workspaceId,
        JSON.stringify(asset),
        input.idempotencyKey,
        input.requestDigest,
        input.actor,
        input.recordedAt,
      ],
    )
  }

  async #insertJob(query: ScopedQuery, asset: PublishedPackAsset, input: CommitApprovedPackInput): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.jobs
         (tenant_id, space_id, job_id, kind, source_ref, dataset_ref, pipeline_version, stage,
          idempotency_key, input_digest, revision, attempt_count, abandoned_attempt_count, counts,
          next_attempt_at, created_at, created_by, updated_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, 'asset_publication', $2, $2, 'pack-publication@1.0.0', 'published',
         $3, $4, 1, 0, 0, '{}'::jsonb, $5::timestamptz, $5::timestamptz, $6, $5::timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        input.outboxJobId,
        asset.packRef.id,
        input.outbox.idempotencyKey,
        asset.contentDigest,
        input.recordedAt,
        input.actor,
      ],
    )
  }

  async #insertOutbox(query: ScopedQuery, jobId: string, outbox: NewOutboxMessage): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.job_outbox
         (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state, attempts,
          available_at, created_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, $2::uuid, $3, $4::jsonb, $5, 'pending', 0, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
      [
        outbox.outboxId,
        jobId,
        outbox.topic,
        JSON.stringify(outbox.payload),
        outbox.idempotencyKey,
        outbox.availableAt,
        outbox.createdAt,
      ],
    )
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<AssetRow | undefined> {
    const result = await query.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM agent_platform.published_pack_assets
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #byPackIdVersion(query: ScopedQuery, packId: string, version: string): Promise<AssetRow | undefined> {
    const result = await query.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM agent_platform.published_pack_assets
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND pack_id = $1 AND version = $2`,
      [packId, version],
    )
    return result.rows[0]
  }

  async #byNamespaceVersion(query: ScopedQuery, namespace: string, version: string): Promise<AssetRow | undefined> {
    const result = await query.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM agent_platform.published_pack_assets
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND namespace = $1 AND version = $2`,
      [namespace, version],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new PublishedPackAssetStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new PublishedPackAssetStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new PublishedPackAssetStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
    }
    return this.#database.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) => {
        await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
        return run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        })
      },
    )
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new PublishedPackAssetStoreError('INVALID_ASSET', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}
