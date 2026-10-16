import { join } from 'node:path'
import { ModelSelectionError, SecretValue } from '@ontology/contracts'
import type { ModelCredentialCustodian, ResourceRef, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'
import { LocalCredentialCustody } from './local-credential-custody'
import type { CredentialCustodyFailureCode } from './local-credential-custody'

/**
 * Local, OS-protected model-credential custody (design §5.3, §5.5).
 *
 * A thin adapter over the shared `LocalCredentialCustody`: the encryption, atomic-write and
 * idempotency behaviour lives in one place, and each host maps a custody failure onto its own
 * domain error. Model API keys stay under the `credentials` namespace beside the object store.
 */
export class LocalModelCredentialCustodian implements ModelCredentialCustodian {
  readonly #custody: LocalCredentialCustody

  constructor(input: { readonly objectDirectory: string }) {
    this.#custody = new LocalCredentialCustody({
      root: join(input.objectDirectory, '.core-settings'),
      namespace: 'credentials',
      fail: (code: CredentialCustodyFailureCode, message: string) => new ModelSelectionError(code, message),
    })
  }

  stage(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly secret: SecretValue },
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    return this.#custody.stage(scopeRef, input, ctx)
  }

  activate(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void> {
    return this.#custody.activate(scopeRef, credentialRef, ctx)
  }

  discard(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void> {
    return this.#custody.discard(scopeRef, credentialRef, ctx)
  }

  revoke(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    return this.#custody.revoke(scopeRef, connectionId, ctx)
  }

  resolve(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<SecretValue> {
    return this.#custody.resolve(scopeRef, credentialRef, ctx)
  }
}
