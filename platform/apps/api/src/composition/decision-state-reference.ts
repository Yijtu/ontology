import { createHash } from 'node:crypto'
import { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ArtifactRegistry, ImmutableObjectStore } from '@ontology/adapter-blob-local'
import type { DecisionStateRefProvider } from '@ontology/application'
import type { DecisionStateReferenceStore, ScopeRef, Uuid } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { canonicalJson } from '@ontology/tool-services'

const MAX_DECISION_STATE_BYTES = 1_048_576

export interface CoreDecisionStateReferenceOptions {
  readonly objectStore: ImmutableObjectStore
  readonly artifactRegistry: ArtifactRegistry
  readonly references: DecisionStateReferenceStore
  readonly scopeRef: ScopeRef
  readonly now?: () => string
}

/** Archive a complete bounded state artifact, then register its exact run/profile authorization. */
export function createCoreDecisionStateRefProvider(options: CoreDecisionStateReferenceOptions): DecisionStateRefProvider {
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async archive(input, ctx) {
      if (input.runId !== ctx.runId || input.resolvedProfileHash !== ctx.resolvedProfileHash) {
        throw new Error('decision state must be archived for the canonical run and locked profile')
      }
      const encoded = canonicalJson(input.state)
      const bytes = new TextEncoder().encode(encoded)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DECISION_STATE_BYTES) {
        throw new Error('decision state is outside the bounded archive size')
      }
      const stateDigest = sha256DigestOf(encoded)
      const blobStore = new LocalImmutableBlobStore({
        objectStore: options.objectStore,
        registry: options.artifactRegistry,
        idFactory: () => stableUuid(`decision-state:${input.runId}:${input.resolvedProfileHash}:${stateDigest}`),
        now,
      })
      const staged = await blobStore.stage(bytes, { scopeRef: options.scopeRef }, ctx)
      const saved = await blobStore.publish({
        scopeRef: options.scopeRef,
        contentDigest: staged.contentDigest,
        mediaType: 'application/json',
        byteSize: staged.byteSize,
        purpose: 'artifact',
        origin: {
          kind: 'decision_state',
          runId: input.runId,
          resolvedProfileHash: input.resolvedProfileHash,
        },
      }, ctx)
      await options.references.register(options.scopeRef, {
        runId: input.runId,
        resolvedProfileHash: input.resolvedProfileHash,
        stateRef: saved.blobRef,
        registeredAt: now(),
      }, ctx)
      return saved.blobRef
    },
  }
}

function stableUuid(seed: string): Uuid {
  const chars = [...createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
