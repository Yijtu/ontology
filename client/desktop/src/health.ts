/**
 * Reachability and credential probe, run in the main process before the shell loads any remote UI.
 *
 * `/healthz` is deliberately unauthenticated on the server, so a reachable-but-wrong-token server is
 * reported as an authentication problem rather than as "offline". The probe never prints the token.
 */
export interface ProbeResult {
  readonly ok: boolean
  readonly message: string
  /** `unreachable` | `unauthenticated` | `not_core` | `client_older_than_server` */
  readonly kind?: 'unreachable' | 'unauthenticated' | 'not_core' | 'client_older_than_server'
}

const TIMEOUT_MS = 8_000

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' })
  } finally {
    clearTimeout(timer)
  }
}

export async function probeServer(serverUrl: string, token: string): Promise<ProbeResult> {
  const base = trimSlash(serverUrl)
  try {
    const health = await fetchWithTimeout(`${base}/healthz`)
    if (!health.ok) {
      return { ok: false, kind: 'unreachable', message: `服务端未就绪（healthz ${String(health.status)}）` }
    }
  } catch {
    return { ok: false, kind: 'unreachable', message: '无法连接服务端，请检查地址、网络与证书' }
  }

  let deployment: Response
  try {
    deployment = await fetchWithTimeout(`${base}/api/v1/core/deployment`, {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    return { ok: false, kind: 'unreachable', message: '服务端可达，但业务接口请求失败' }
  }
  if (deployment.status === 401) {
    return { ok: false, kind: 'unauthenticated', message: '访问令牌无效或已更换' }
  }
  if (deployment.status === 404) {
    return { ok: false, kind: 'not_core', message: '该地址不是 Ontology Core 服务端' }
  }
  if (!deployment.ok) {
    return { ok: false, kind: 'unreachable', message: `业务接口返回 ${String(deployment.status)}` }
  }
  return { ok: true, message: '连接成功' }
}
