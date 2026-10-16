import { join } from 'node:path'
import { ToolConnectionError, SecretValue } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, ToolContext, ToolCredentialCustodian, Uuid } from '@ontology/contracts'
import { LocalCredentialCustody } from './local-credential-custody'
import type { CredentialCustodyFailureCode } from './local-credential-custody'

/**
 * Local, OS-protected tool-credential custody (design §9).
 *
 * The same custody boundary the model connections use, but under the `tool-credentials` namespace
 * so a model and a tool never share a directory. A value is written once (`stage` → `activate`) and
 * never read back into a domain entity or a log; `resolve` returns the non-serializable
 * `SecretValue`. Failures classify as `ToolConnectionError` so the tool catalogue reports them the
 * same way a probe would.
 */
export class LocalToolCredentialCustodian implements ToolCredentialCustodian {
  readonly #custody: LocalCredentialCustody

  constructor(input: { readonly objectDirectory: string }) {
    this.#custody = new LocalCredentialCustody({
      root: join(input.objectDirectory, '.core-settings'),
      namespace: 'tool-credentials',
      fail: (code: CredentialCustodyFailureCode, message: string) => new ToolConnectionError(code, message),
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
