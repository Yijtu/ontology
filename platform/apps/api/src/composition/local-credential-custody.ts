import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SecretValue, isToolContext } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'

/** The failure axes a custody operation can raise; each host maps them onto its domain error. */
export type CredentialCustodyFailureCode = 'CREDENTIAL_MISSING' | 'STORE_FAILED' | 'SCOPE_MISMATCH'

/**
 * Local, OS-protected credential custody shared by model and tool connections (design §5.3, §9).
 *
 * A value is encrypted with AES-256-GCM under a per-scope master key kept beside the object store
 * (never in the control database or the repository). It is written once (`stage` → `activate`),
 * never read back into a domain entity and never logged; `resolve` returns the non-serializable
 * `SecretValue`. Every operation is idempotent, so an interrupted write can be discarded and
 * retried. A `namespace` keeps two credential families (e.g. model vs tool) in separate
 * directories while sharing the same custody implementation. The `fail` factory lets each host
 * raise its own domain error code (a model connection and a tool connection classify failures the
 * same way, but under different error classes). This is the local-dev backend; a production
 * deployment may swap in an OS keychain / KMS backend behind the same ports.
 */
export class LocalCredentialCustody {
  readonly #root: string
  readonly #namespace: string
  readonly #fail: (code: CredentialCustodyFailureCode, message: string) => Error

  constructor(input: {
    readonly root: string
    readonly namespace?: string
    readonly fail: (code: CredentialCustodyFailureCode, message: string) => Error
  }) {
    this.#root = input.root
    this.#namespace = input.namespace ?? 'credentials'
    this.#fail = input.fail
  }

  async stage(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly secret: SecretValue },
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    this.#assertScope(scopeRef, ctx)
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
      throw this.#fail('STORE_FAILED', 'the credential could not be activated')
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
        throw this.#fail('CREDENTIAL_MISSING', 'the referenced credential is not available')
      }
    }
    let payload: unknown
    try {
      payload = JSON.parse(decrypt(key, ciphertext))
    } catch {
      throw this.#fail('CREDENTIAL_MISSING', 'the referenced credential could not be read')
    }
    if (typeof payload !== 'object' || payload === null) {
      throw this.#fail('CREDENTIAL_MISSING', 'the referenced credential is malformed')
    }
    const secret = (payload as { secret?: unknown }).secret
    if (typeof secret !== 'string' || secret.length === 0) {
      throw this.#fail('CREDENTIAL_MISSING', 'the referenced credential is empty')
    }
    return new SecretValue(secret)
  }

  #assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) {
      throw this.#fail('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw this.#fail('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw this.#fail('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
  }

  async #directory(scopeRef: ScopeRef): Promise<string> {
    if (!isUuidShaped(scopeRef.tenantId) || !isUuidShaped(scopeRef.spaceId)) {
      throw this.#fail('SCOPE_MISMATCH', 'the credential store scope must be a uuid pair')
    }
    const directory = join(this.#root, scopeRef.tenantId, scopeRef.spaceId, this.#namespace)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  async #masterKey(directory: string): Promise<Buffer> {
    const path = join(directory, 'master.key')
    try {
      const key = await readFile(path)
      if (key.length === 32) return key
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw this.#fail('STORE_FAILED', 'the credential master key could not be read')
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    await writeFile(path, key, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)
    return key
  }
}

/** A cheap UUID shape check, mirroring the model-custody scope guard without importing the parser. */
function isUuidShaped(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
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

export function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
