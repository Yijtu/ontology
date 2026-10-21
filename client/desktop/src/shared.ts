/**
 * Pure URL rules for the desktop shell.
 *
 * These are kept free of Electron so they can be unit-tested with `node --test`, and because they
 * encode the security decisions the shell must not get wrong: which server may be configured, which
 * navigations stay inside the app, and to which requests the bearer token may be attached.
 */

export interface ServerUrlResult {
  readonly ok: boolean
  readonly url?: string
  readonly reason?: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHostname(hostname: string): boolean {
  // WHATWG URL keeps IPv6 brackets in `hostname` (`[::1]`), while the comparison set is unbracketed.
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost')
}

/**
 * Normalize and validate the configured server address.
 *
 * Only `http`/`https` are accepted. Plain `http` is allowed for loopback only, so a self-hosted test
 * setup works while a remote server must use TLS — the shell never talks to a remote server in
 * cleartext, and it never ignores certificate errors.
 */
export function validateServerUrl(input: unknown): ServerUrlResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: '请输入服务端地址' }
  }
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return { ok: false, reason: '地址格式不正确，例如 https://core.example.com' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: '只支持 http 或 https' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: '地址里不要带用户名或密码' }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: '地址里不要带查询参数或片段' }
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    return { ok: false, reason: '远程服务端必须使用 https（本机调试可用 http）' }
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '')
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${pathname}` }
}

/** The origin a request belongs to, or `undefined` when it is not an absolute http(s) URL. */
export function originOf(target: string): string | undefined {
  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

/**
 * A navigation stays inside the app only when it targets the configured server origin.
 *
 * Everything else is refused and handed to the system browser instead: the renderer runs remote
 * content, so letting it navigate the shell window anywhere would hand a web page the desktop window.
 */
export function isAllowedNavigation(target: string, serverUrl: string): boolean {
  const targetOrigin = originOf(target)
  const serverOrigin = originOf(serverUrl)
  if (targetOrigin === undefined || serverOrigin === undefined) return false
  return targetOrigin === serverOrigin
}

/** The bearer token is attached only to requests for the configured server origin. */
export function shouldAttachToken(target: string, serverUrl: string): boolean {
  return isAllowedNavigation(target, serverUrl)
}

/**
 * An external link may only be opened in the system browser when it is plain web content.
 * `file:`, `javascript:`, custom protocols and `data:` are refused.
 */
export function isExternalWebUrl(target: string): boolean {
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
