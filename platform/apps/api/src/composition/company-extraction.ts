import { randomUUID } from 'node:crypto'
import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type { ModelCallEvidenceRecorder } from '@ontology/adapter-model-company'
import { EXTRACTION_RESPONSE_SCHEMA_REF, parseModelCandidates } from '@ontology/application'
import type { BudgetLedgerPort, EvidenceEnvelope, EvidenceStorePort, ToolContext, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { createEnvSecretResolver } from './secret-resolver'
import type { LocalExtractionGeneration } from './local-native-candidates'

const MODEL_ID = 'ontology-extractor'
const MODEL_REF = { modelId: MODEL_ID, version: '1.0.0' } as const
/** Optional model adapter for text spans. Native strong-ID records remain deterministic. */
export function createCompanyExtractionGeneration(input: {
  readonly budget: BudgetLedgerPort
  readonly evidence: EvidenceStorePort
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetchImpl?: typeof fetch
}): LocalExtractionGeneration | undefined {
  const env = input.env ?? process.env
  const baseUrl = env['ONTOLOGY_COMPANY_MODEL_BASE_URL']?.trim()
  const vendorModel = env['ONTOLOGY_EXTRACTION_VENDOR_MODEL']?.trim()
  if (baseUrl === undefined && vendorModel === undefined) return undefined
  if (!baseUrl || !vendorModel) {
    throw new Error('configure both ONTOLOGY_COMPANY_MODEL_BASE_URL and ONTOLOGY_EXTRACTION_VENDOR_MODEL to enable text extraction')
  }
  const protocol = env['ONTOLOGY_COMPANY_MODEL_PROTOCOL'] ?? 'openai-compatible'
  if (protocol !== 'private' && protocol !== 'openai-compatible') {
    throw new Error('ONTOLOGY_COMPANY_MODEL_PROTOCOL must be private or openai-compatible')
  }
  const endpoint = env['ONTOLOGY_COMPANY_MODEL_ENDPOINT']?.trim() ?? (protocol === 'private' ? 'v1/generate' : 'chat/completions')
  const componentRef: VersionRef = {
    id: 'local-company-extraction', version: '1.0.0',
    digest: sha256DigestOf(JSON.stringify({ modelId: MODEL_ID, vendorModel, protocol, baseUrl, endpoint, outputLimit: 2048 })),
  }
  const recorderFor = (ledgerId: string): ModelCallEvidenceRecorder => ({
    async record(request, ctx: ToolContext) {
      const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
      const now = new Date().toISOString()
      const body = {
        evidenceId: randomUUID(), kind: 'model_output' as const, scopeRef,
        producedBy: { componentRef, runId: ledgerId },
        observedAt: now, sourceSnapshots: [], resultDigest: request.outputDigest,
        dependencies: [], dataMode: 'synthetic' as const,
        limitations: ['untrusted model candidate; requires schema validation and human review'],
      }
      const envelope: EvidenceEnvelope = {
        ...body,
        integrity: { algorithm: 'sha256', digest: sha256DigestOf(JSON.stringify(body)), verifiedAt: now },
      }
      return (await input.evidence.record(scopeRef, envelope, ctx)).evidenceRef
    },
  })
  return {
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 2048 },
    create: (ledgerId, signal) => new CompanyGenerationAdapter({
      baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
      endpoint: endpoint.startsWith('/') ? endpoint.slice(1) : endpoint,
      protocol,
      secretRef: 'env:ONTOLOGY_COMPANY_MODEL_API_KEY',
      models: { [MODEL_ID]: { vendorModel } },
      secrets: createEnvSecretResolver({ env }),
      budget: input.budget, ledgerId, evidence: recorderFor(ledgerId), signal,
      maxAttempts: 2, requestTimeoutMs: 30_000,
      schemaValidator: {
        async validate(ref, candidate) {
          if (ref.id !== EXTRACTION_RESPONSE_SCHEMA_REF.id || ref.version !== EXTRACTION_RESPONSE_SCHEMA_REF.version || ref.digest !== EXTRACTION_RESPONSE_SCHEMA_REF.digest) {
            return { valid: false, errors: ['unknown extraction response schema'] }
          }
          try {
            parseModelCandidates(JSON.stringify(candidate))
            return { valid: true }
          } catch {
            return { valid: false, errors: ['malformed entity, relation or rule candidate'] }
          }
        },
      },
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    }),
  }
}
