import {
  INDUSTRY_WORKSPACE_CREATED_TOPIC,
  INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC,
  PACK_PUBLISHED_TOPIC,
  PROJECT_CREATED_TOPIC,
  PROJECT_REVISION_APPENDED_TOPIC,
} from '@ontology/application'
import type { OutboxConsumer } from '@ontology/application'
import type {
  CandidateStore,
  IndustryWorkspaceStore,
  OutboxMessageRecord,
  ProjectStore,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { PostgresPublishedPackAssetStore } from '@ontology/adapter-control-postgres'
import { isRecord } from './core-composition-shared'

/**
 * The Core host's outbox consumers. Each one only re-verifies that the immutable row the source
 * transaction committed together with the outbox message is durably visible before acking; none
 * creates state or revives work the source transaction did not commit.
 */

export class CoreFactsOutboxFallback implements OutboxConsumer {
  readonly topics = ['extraction.candidates.produced'] as const
  readonly #candidates: CandidateStore
  readonly #scopeRef: ScopeRef

  constructor(candidates: CandidateStore, scopeRef: ScopeRef) {
    this.#candidates = candidates
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (message.topic !== this.topics[0] || !isRecord(message.payload)) throw new Error('unregistered Core outbox topic')
    const candidateCount = message.payload['candidateCount']
    if (message.payload['jobId'] !== message.jobId || typeof candidateCount !== 'number' || !Number.isSafeInteger(candidateCount)) {
      throw new Error('candidate-produced event is malformed')
    }
    const counts = await this.#candidates.countCandidates(this.#scopeRef, message.jobId, ctx)
    if (counts.total !== candidateCount) throw new Error('candidate-produced event does not match durable candidate rows')
  }
}

export class UnsupportedOutboxConsumer implements OutboxConsumer {
  consume(message: OutboxMessageRecord, _ctx: ToolContext): Promise<void> {
    void _ctx
    return Promise.reject(new Error(`no Core outbox consumer is registered for ${message.topic}`))
  }
}

/**
 * Acknowledge the industry-workspace lifecycle topics. The workspace write already committed
 * the workspace row and the immutable draft revision in the same transaction as the outbox
 * row, so the consumer only re-verifies that the referenced revision is durably visible
 * before acking; it creates no state and never revives a workspace the source transaction
 * did not commit.
 */
export class IndustryWorkspaceOutboxConsumer implements OutboxConsumer {
  readonly topics = [
    INDUSTRY_WORKSPACE_CREATED_TOPIC,
    INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC,
  ] as const
  readonly #store: IndustryWorkspaceStore
  readonly #scopeRef: ScopeRef

  constructor(store: IndustryWorkspaceStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('industry workspace outbox payload is malformed')
    const workspaceId = message.payload['workspaceId']
    const revision = message.payload['revision']
    if (typeof workspaceId !== 'string' || typeof revision !== 'string') {
      throw new Error('industry workspace outbox payload is malformed')
    }
    const workspace = await this.#store.getWorkspace(this.#scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new Error('industry workspace outbox references an unknown workspace')
    }
    const draft = await this.#store.getDraft(this.#scopeRef, workspaceId, revision, ctx)
    if (draft === undefined) {
      throw new Error('industry workspace outbox references an unknown draft revision')
    }
  }
}

/**
 * Acknowledge the `asset.pack.published` lifecycle topic. The publication transaction already
 * committed the immutable pack row, the definition version and the outbox row atomically, so the
 * consumer only re-verifies that the referenced pack is durably visible before acking; it creates
 * no state and never revives a publication the source transaction did not commit.
 */
export class PackPublicationOutboxConsumer implements OutboxConsumer {
  readonly topics = [PACK_PUBLISHED_TOPIC] as const
  readonly #store: PostgresPublishedPackAssetStore
  readonly #scopeRef: ScopeRef

  constructor(store: PostgresPublishedPackAssetStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('asset pack publication outbox payload is malformed')
    const packId = message.payload['packId']
    const version = message.payload['version']
    if (typeof packId !== 'string' || typeof version !== 'string') {
      throw new Error('asset pack publication outbox payload is malformed')
    }
    const asset = await this.#store.findPack(this.#scopeRef, packId, version, ctx)
    if (asset === undefined) {
      throw new Error('asset pack publication outbox references an unknown published pack')
    }
  }
}

/**
 * Acknowledge the `project.*` lifecycle topics. The project write already committed the project
 * head and the immutable revision in the same transaction as the outbox row, so the consumer only
 * re-verifies the referenced revision is durably visible before acking; it creates no state.
 */
export class ProjectRevisionOutboxConsumer implements OutboxConsumer {
  readonly topics = [PROJECT_CREATED_TOPIC, PROJECT_REVISION_APPENDED_TOPIC] as const
  readonly #store: ProjectStore
  readonly #scopeRef: ScopeRef

  constructor(store: ProjectStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('project outbox payload is malformed')
    const projectId = message.payload['projectId']
    const revision = message.payload['revision']
    if (typeof projectId !== 'string' || typeof revision !== 'string') {
      throw new Error('project outbox payload is malformed')
    }
    const stored = await this.#store.getRevision(this.#scopeRef, projectId, revision, ctx)
    if (stored === undefined) {
      throw new Error('project outbox references an unknown project revision')
    }
  }
}
