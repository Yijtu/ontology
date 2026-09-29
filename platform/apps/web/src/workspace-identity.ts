/**
 * The client-side identity seam for the workspace home (AGENTS: ids/randomness are injected, not
 * read from ambient global state). The default uses the browser's Web Crypto so a source-set
 * reference carries a real SHA-256 digest rather than a placeholder; a test injects a
 * deterministic implementation so a jsdom run does not depend on `crypto.subtle`.
 */
export interface WorkspaceIdentity {
  newId(): string
  /** `sha256:<hex>` of the UTF-8 text. Throws rather than returning a non-digest placeholder. */
  sha256(text: string): Promise<string>
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export const webWorkspaceIdentity: WorkspaceIdentity = {
  newId(): string {
    const randomUuid = globalThis.crypto?.randomUUID
    if (typeof randomUuid === 'function') return globalThis.crypto.randomUUID()
    throw new Error('the browser crypto API is required to mint a workspace identity')
  },
  async sha256(text: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (subtle === undefined) {
      throw new Error('the browser SubtleCrypto API is required to digest a source set')
    }
    const encoded = new TextEncoder().encode(text)
    const digest = await subtle.digest('SHA-256', encoded)
    return `sha256:${toHex(digest)}`
  },
}
