import { CompanyHttpClient } from './http-client'
import type { CompanyModelProtocol } from './types'
import { createWireCodec } from './vendor/codec'

export interface CompanyModelProbeInput {
  readonly baseUrl: string
  readonly endpoint: string
  readonly vendorModel: string
  readonly protocol: CompanyModelProtocol
  readonly apiKey: string
}

export type CompanyModelProbeReason =
  | 'authentication_failed'
  | 'timeout'
  | 'rate_limited'
  | 'protocol_mismatch'
  | 'unreachable'
  | 'invalid_response'

export interface CompanyModelConnectionProbeResult {
  readonly status: 'passed' | 'failed'
  readonly reason?: CompanyModelProbeReason
  readonly latencyMs: number
}

interface ProbeOutcome {
  readonly reachable: boolean
  readonly message: string
  readonly reason?: CompanyModelProbeReason
}

/**
 * A bounded byte/redirect guard shared by the connectivity probes: 8s timeout, 64 KiB / 256 chunk
 * response ceiling, redirects refused. It never echoes a provider body.
 */
function boundedFetchFor(signal: AbortSignal, controller: AbortController, upstream: typeof fetch): typeof fetch {
  return async (url, init) => {
    signal.throwIfAborted()
    const response = await upstream(url, { ...init, signal, redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      return new Response(null, { status: response.status })
    }
    if (response.body === null) return response
    const reader = response.body.getReader()
    let bytes = 0
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const next = await reader.read()
          if (next.done) { target.close(); return }
          bytes += next.value.byteLength
          if (bytes > 65_536 || ++chunks > 256) {
            controller.abort()
            await reader.cancel()
            target.error(new Error('probe response exceeded its limit'))
            return
          }
          target.enqueue(next.value)
        } catch { target.error(new Error('probe response unavailable')) }
      },
      async cancel() { await reader.cancel().catch(() => undefined) },
    })
    return new Response(body, { status: response.status, headers: response.headers })
  }
}

async function probeCompanyModelInternal(
  input: CompanyModelProbeInput,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal },
): Promise<ProbeOutcome> {
  const controller = new AbortController()
  const signal = AbortSignal.any([AbortSignal.timeout(8_000), controller.signal, ...(options.signal === undefined ? [] : [options.signal])])
  const boundedFetch = boundedFetchFor(signal, controller, options.fetchImpl ?? globalThis.fetch)
  try {
    signal.throwIfAborted()
    const client = new CompanyHttpClient({ baseUrl: input.baseUrl, endpoint: input.endpoint, fetchImpl: boundedFetch })
    const result = await client.send({ vendorModel: input.vendorModel, apiKey: input.apiKey, messages: [{ role: 'user', content: 'Reply with OK.' }], evidenceRefs: [], maxTokens: 16, signal })
    if (result.status === 401 || result.status === 403) return { reachable: false, reason: 'authentication_failed', message: '模型服务拒绝认证，请检查密钥和访问权限。' }
    if (result.status === 429) return { reachable: false, reason: 'rate_limited', message: '模型服务限流，请稍后重试。' }
    if (result.status < 200 || result.status >= 300) return { reachable: false, reason: 'invalid_response', message: `模型服务返回 HTTP ${result.status}，请检查地址、模型名称及服务状态。` }
    const codec = createWireCodec(input.protocol)
    for await (const payload of result.payloads) {
      signal.throwIfAborted()
      const decoded = codec.decode(payload)
      if (decoded === undefined) return { reachable: false, reason: 'protocol_mismatch', message: '响应格式与所选协议不符，请核对协议及接口路径。' }
      if (decoded.some((chunk) => chunk.type === 'text_delta' && chunk.text.trim().length > 0)) return { reachable: true, message: '已收到模型的有效测试回复。连通成功不代表业务答案已通过验核。' }
    }
    return { reachable: false, reason: 'invalid_response', message: '模型未返回可识别的文本，请检查模型名称和流式协议。' }
  } catch {
    return { reachable: false, reason: signal.aborted ? 'timeout' : 'unreachable', message: '连接未完成：请检查网络、地址和协议；测试上限为 8 秒、64 KiB。' }
  } finally { controller.abort() }
}

/** A small operator-requested connectivity check, never a published business answer. */
export async function probeCompanyModel(input: CompanyModelProbeInput, options: {
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
} = {}): Promise<{ readonly reachable: boolean; readonly message: string }> {
  const outcome = await probeCompanyModelInternal(input, options)
  return { reachable: outcome.reachable, message: outcome.message }
}

/**
 * A classified connectivity probe for the model-connection catalogue: it reports a stable,
 * sanitized reason code (never the provider body) and the measured latency.
 */
export async function probeCompanyModelConnection(input: CompanyModelProbeInput, options: {
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
} = {}): Promise<CompanyModelConnectionProbeResult> {
  const started = Date.now()
  const outcome = await probeCompanyModelInternal(input, options)
  return {
    status: outcome.reachable ? 'passed' : 'failed',
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    latencyMs: Date.now() - started,
  }
}
