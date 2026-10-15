import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ModelSelectionError, SecretValue, isToolContext, isUuid } from '@ontology/contracts'
import type { ModelCredentialCustodian, ResourceRef, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'

/**
 * Local, OS-protected credential custody (design §5.3, §5.5).
 *
 * Model API keys are encrypted with AES-256-GCM under a per-scope master key kept beside the
 * object store (never in the control database or the repository). A value is written once
 * (`stage` → `activate`), never read back into a domain entity and never logged; `resolve`
 * returns the non-serializable `SecretValue`. Every operation is idempotent, so an interrupted
 * write can be discarded and retried. This is the local-dev backend; a production deployment may
 * swap in an OS keychain / KMS backend behind the same port.
 */
export class LocalModelCredentialCustodian implements ModelCredentialCustodian {
  readonly #root: string

  constructor(input: { readonly objectDirectory: string }) {
    this.#root = join(input.objectDirectory, '.core-settings')
  }

  async stage(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly secret: SecretValue },
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    this.#assertScope(scopeRef, ctx)
    if (!isUuid(input.connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    const directory = await this.#directory(scopeRef)
    const key = await this.#masterKey(directory)
    const id = randomUUID()
    const payload = JSON.stringify({ connectionId: input.connectionId, secret: input.secret.reveal() })
    const ciphertext = encrypt(key, payload)
    const path = join(directory, `${id}.pending`)
    await writeFile(path, ciphertext, { flag: 'wx', mode: 0o600 })
    return {
      id,
      version: '1.0.0',
      digest: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      kind: 'artifact',
    }
  }

  async activate(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void> {
    this.#assertScope(scopeRef, ctx)
    const directory = await this.#directory(scopeRef)
    const pending = join(directory, `${credentialRef.id}.pending`)
    const active = join(directory, `${credentialRef.id}.active`)
    try {
      await rename(pending, active)
    } catch (error) {
      // Idempotent: already active, or nothing was staged.
      if (isCode(error, 'ENOENT')) {
        await readFile(active).catch(() => {})
        return
      }
      throw new ModelSelectionError('STORE_FAILED', 'the credential could not be activated')
    }
  }

  async discard(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void> {
    this.#assertScope(scopeRef, ctx)
    const directory = await this.#directory(scopeRef)
    await unlink(join(directory, `${credentialRef.id}.pending`)).catch(() => undefined)
    await unlink(join(directory, `${credentialRef.id}.active`)).catch(() => undefined)
  }

  async revoke(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    this.#assertScope(scopeRef, ctx)
    const directory = await this.#directory(scopeRef)
    const key = await this.#masterKey(directory)
    const entries = await readdir(directory).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith('.pending') && !entry.endsWith('.active')) continue
      const path = join(directory, entry)
      try {
        const payload: unknown = JSON.parse(decrypt(key, await readFile(path)))
        if (typeof payload === 'object' && payload !== null && (payload as { connectionId?: unknown }).connectionId === connectionId) {
          await unlink(path).catch(() => undefined)
        }
      } catch {
        // A record that cannot be read is left alone; it is never a secret leak.
      }
    }
  }

  async resolve(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<SecretValue> {
    this.#assertScope(scopeRef, ctx)
    const directory = await this.#directory(scopeRef)
    const key = await this.#masterKey(directory)
    const active = join(directory, `${credentialRef.id}.active`)
    const pending = join(directory, `${credentialRef.id}.pending`)
    let ciphertext: Buffer
    try {
      ciphertext = await readFile(active)
    } catch {
      try {
        ciphertext = await readFile(pending)
      } catch {
        throw new ModelSelectionError('CREDENTIAL_MISSING', 'the referenced credential is not available')
      }
    }
    let payload: unknown
    try {
      payload = JSON.parse(decrypt(key, ciphertext))
    } catch {
      throw new ModelSelectionError('CREDENTIAL_MISSING', 'the referenced credential could not be read')
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new ModelSelectionError('CREDENTIAL_MISSING', 'the referenced credential is malformed')
    }
    const secret = (payload as { secret?: unknown }).secret
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new ModelSelectionError('CREDENTIAL_MISSING', 'the referenced credential is empty')
    }
    return new SecretValue(secret)
  }

  #assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
  }

  async #directory(scopeRef: ScopeRef): Promise<string> {
    if (!isUuid(scopeRef.tenantId) || !isUuid(scopeRef.spaceId)) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'the credential store scope must be a uuid pair')
    }
    const directory = join(this.#root, scopeRef.tenantId, scopeRef.spaceId, 'credentials')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  async #masterKey(directory: string): Promise<Buffer> {
    const path = join(directory, 'master.key')
    try {
      const key = await readFile(path)
      if (key.length === 32) return key
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw new ModelSelectionError('STORE_FAILED', 'the credential master key could not be read')
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    await writeFile(path, key, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)
    return key
  }
}

function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data])
}

function decrypt(key: Buffer, ciphertext: Buffer): string {
  if (ciphertext.length < 12 + 16) throw new Error('credential record too short')
  const iv = ciphertext.subarray(0, 12)
  const tag = ciphertext.subarray(12, 28)
  const data = ciphertext.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
