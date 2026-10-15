import { probeCompanyModelConnection } from '@ontology/adapter-model-company'
import type { CompanyModelConnectionProbeResult, CompanyModelProtocol } from '@ontology/adapter-model-company'
import type {
  ModelConnectionDescriptor,
  ModelConnectionProbePort,
  ModelConnectionTestReason,
  ModelConnectionTestResult,
  ModelCredentialCustodian,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'

/**
 * Production probe for the model-connection catalogue (design §5.3).
 *
 * It reuses the company adapter's bounded, redirect-refusing, body-discarding connectivity check
 * for generation/research adapters and a matching bounded probe for the JEV adapter. It always
 * reports a sanitized reason code and never echoes the credential or a provider body.
 */
export function createCoreModelProbe(input: { readonly credentials: ModelCredentialCustodian }): ModelConnectionProbePort {
  return {
    async probe(
      scopeRef: ScopeRef,
      request: { readonly draft: ModelConnectionDescriptor; readonly credentialRef?: ResourceRef; readonly signal?: AbortSignal },
      ctx: ToolContext,
    ): Promise<ModelConnectionTestResult> {
      const testedAt = new Date().toISOString()
      const descriptor = request.draft
      let apiKey: string | undefined
      if (request.credentialRef !== undefined) {
        try {
          apiKey = (await input.credentials.resolve(scopeRef, request.credentialRef, ctx)).reveal()
        } catch {
          return failed(testedAt, 'authentication_failed', true)
        }
      }
      if (apiKey === undefined) return failed(testedAt, 'authentication_failed', false)
      if (descriptor.baseUrl === undefined) return failed(testedAt, 'unreachable', true)

      if (descriptor.adapterType === 'jev') {
        const result = await probeJev(descriptor, apiKey, request.signal)
        return fromResult(testedAt, result.status, result.reason, result.latencyMs)
      }
      if (descriptor.protocol === 'jev') return failed(testedAt, 'protocol_mismatch', true)
      const protocol: CompanyModelProtocol = descriptor.protocol === 'private' ? 'private' : 'openai-compatible'
      const result = await probeCompanyModelConnection({
        baseUrl: descriptor.baseUrl,
        endpoint: descriptor.endpoint ?? (protocol === 'private' ? '/v1/generate' : '/v1/chat/completions'),
        vendorModel: descriptor.providerModelName,
        protocol,
        apiKey,
      }, request.signal === undefined ? {} : { signal: request.signal })
      return fromResult(testedAt, result.status, result.reason, result.latencyMs)
    },
  }
}

function fromResult(
  testedAt: string,
  status: 'passed' | 'failed',
  reason: ModelConnectionTestReason | undefined,
  latencyMs: number,
): ModelConnectionTestResult {
  return {
    schemaVersion: 'model-connection-test-result@1',
    status,
    testedAt,
    draft: false,
    credentialConfigured: true,
    latencyMs,
    ...(reason === undefined ? {} : { reason }),
  }
}

function failed(testedAt: string, reason: ModelConnectionTestReason, credentialConfigured: boolean): ModelConnectionTestResult {
  return {
    schemaVersion: 'model-connection-test-result@1',
    status: 'failed',
    testedAt,
    reason,
    draft: false,
    credentialConfigured,
  }
}

/** A bounded JEV reachability probe: 8s, redirects refused, response discarded. */
async function probeJev(
  descriptor: ModelConnectionDescriptor,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<CompanyModelConnectionProbeResult> {
  const started = Date.now()
  const controller = new AbortController()
  const combined = AbortSignal.any([AbortSignal.timeout(8_000), controller.signal, ...(signal === undefined ? [] : [signal])])
  try {
    const url = new URL(descriptor.endpoint ?? '/v1/systemone', descriptor.baseUrl).toString()
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ probe: true }),
      signal: combined,
      redirect: 'error',
    })
    await response.body?.cancel().catch(() => undefined)
    const status = response.status
    if (status === 401 || status === 403) return { status: 'failed', reason: 'authentication_failed', latencyMs: Date.now() - started }
    if (status === 429) return { status: 'failed', reason: 'rate_limited', latencyMs: Date.now() - started }
    if (status === 404 || status === 405) return { status: 'failed', reason: 'protocol_mismatch', latencyMs: Date.now() - started }
    if (status >= 500) return { status: 'failed', reason: 'invalid_response', latencyMs: Date.now() - started }
    return { status: 'passed', latencyMs: Date.now() - started }
  } catch {
    return { status: 'failed', reason: combined.aborted ? 'timeout' : 'unreachable', latencyMs: Date.now() - started }
  } finally {
    controller.abort()
  }
}
