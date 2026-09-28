import { randomUUID } from 'node:crypto'
import type {
  IdentityDecisionStore,
  IdentityPublishedBindingSnapshot,
  PublishedStatement,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/** Test-only trusted identity snapshot for materializer integration cases that seed a published row. */
export class FixturePublishedIdentityReader implements Pick<IdentityDecisionStore, 'latestReadRevision' | 'readPublishedBindings'> {
  readonly #byCandidate = new Map<Uuid, { readonly statement: PublishedStatement; readonly assertionId: Uuid; readonly decisionId: Uuid }>()
  #revision = 0n

  bindStatements(statements: readonly PublishedStatement[]): void {
    for (const statement of statements) {
      if (statement.kind !== 'entity' || statement.subjectEntityId === undefined || statement.objectId === undefined) continue
      if (this.#byCandidate.has(statement.sourceCandidateId)) continue
      this.#byCandidate.set(statement.sourceCandidateId, {
        statement,
        assertionId: randomUUID(),
        decisionId: randomUUID(),
      })
      this.#revision += 1n
    }
  }

  async latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    void scopeRef
    void ctx
    return this.#revision.toString()
  }

  async readPublishedBindings(
    scopeRef: ScopeRef,
    candidateIds: readonly Uuid[],
    ctx: ToolContext,
  ): Promise<IdentityPublishedBindingSnapshot> {
    void scopeRef
    void ctx
    const readRevision = this.#revision.toString()
    const bindings = candidateIds.map((candidateId) => {
      const found = this.#byCandidate.get(candidateId)
      return {
        candidateId,
        openAssertions: found === undefined ? [] : [{
          assertionId: found.assertionId,
          candidateId,
          entityId: found.statement.subjectEntityId ?? '',
          objectId: found.statement.objectId ?? '',
          identityScopeId: 'fixture-scope',
          decisionId: found.decisionId,
          validFrom: found.statement.recordedAt,
          recordedAt: found.statement.recordedAt,
        }],
        cannotLinkEntityIds: [],
      }
    })
    return { readRevision, bindings, complete: candidateIds.length <= 1_000 }
  }
}
