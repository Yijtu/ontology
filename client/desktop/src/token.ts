import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * The deployment token, sealed with the OS keychain (Windows DPAPI via `safeStorage`).
 *
 * The token is stored on disk only as ciphertext, and it is never handed to a renderer: the shell
 * attaches it to outgoing requests in the main process. When the OS cannot encrypt it, saving is
 * refused instead of silently falling back to plaintext.
 */
function tokenPath(): string {
  return join(app.getPath('userData'), 'token.bin')
}

export function saveToken(token: string): void {
  if (token.length === 0) throw new Error('the access token must not be empty')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统凭据存储不可用，拒绝以明文保存访问令牌')
  }
  const path = tokenPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 })
}

export function loadToken(): string | undefined {
  const path = tokenPath()
  if (!existsSync(path)) return undefined
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    const decrypted = safeStorage.decryptString(readFileSync(path))
    return decrypted.length === 0 ? undefined : decrypted
  } catch {
    // A token sealed by another OS user/machine cannot be opened here; treat it as absent.
    return undefined
  }
}

export function clearToken(): void {
  rmSync(tokenPath(), { force: true })
}
