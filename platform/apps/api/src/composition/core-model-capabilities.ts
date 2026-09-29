import { URL } from 'node:url'
import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type {
  CompanyModelBinding,
  CompanyModelProtocol,
  ModelCallEvidenceRecorder,
  ResponseSchemaValidator,
} from '@ontology/adapter-model-company'
import { JevDecisionAdapter } from '@ontology/adapter-model-jev'
import type {
  DecisionEvidenceRecorder,
  GenerativeClassificationFallback,
  JevActualStateResolver,
  JevFallbackPolicy,
  JevModelBinding,
} from '@ontology/adapter-model-jev'
import type {
  BudgetLedgerPort,
  DecisionPort,
  GenerationPort,
  SecretResolver,
  Uuid,
} from '@ontology/contracts'

export type CoreModelCapabilityName = 'company_generation' | 'jev_decision'

export type CoreModelConfigurationErrorCode =
  | 'INVALID_FLAG'
  | 'MISSING_SETTING'
  | 'INVALID_SETTING'
  | 'DEPENDENCY_NOT_CONFIGURED'

/** A configuration failure that names settings but never includes secret values. */
export class CoreModelConfigurationError extends Error {
  readonly code: CoreModelConfigurationErrorCode
  readonly capability: CoreModelCapabilityName | 'factory'
  readonly setting?: string

  constructor(
    code: CoreModelConfigurationErrorCode,
    capability: CoreModelCapabilityName | 'factory',
    message: string,
    setting?: string,
  ) {
    super(message)
    this.name = 'CoreModelConfigurationError'
    this.code = code
    this.capability = capability
    if (setting !== undefined) this.setting = setting
  }
}

export interface CoreModelCapabilityFactoryDependencies {
  /** Server-only configuration. Browser `VITE_` variables are deliberately ignored. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly secrets: SecretResolver
  readonly budget: BudgetLedgerPort
  readonly generationEvidence?: ModelCallEvidenceRecorder
  readonly decisionEvidence?: DecisionEvidenceRecorder
  readonly decisionStateResolver?: JevActualStateResolver
  readonly schemaValidator?: ResponseSchemaValidator
  readonly generativeClassification?: GenerativeClassificationFallback
  /** Test seam. Production defaults to the platform `fetch`; no request occurs at factory creation. */
  readonly fetchImpl?: typeof fetch
}

export interface CoreModelExecutionContext {
  /** The already-opened run or background-job ledger. The factory never opens a ledger. */
  readonly ledgerId: Uuid
  /** The controller/worker signal for this execution, used by every adapter attempt. */
  readonly signal: AbortSignal
}

export interface CoreModelCapabilities {
  readonly generation?: GenerationPort
  readonly decision?: DecisionPort
}

export interface CoreModelCapabilityFactory {
  readonly generationEnabled: boolean
  readonly decisionEnabled: boolean
  /** Bind adapters to the actual execution ledger and cancellation signal. */
  forExecution(context: CoreModelExecutionContext): CoreModelCapabilities
}

interface CompanyConfiguration {
  readonly baseUrl: string
  readonly endpoint?: string
  readonly secretRef: string
  readonly protocol: CompanyModelProtocol
  readonly models: Readonly<Record<string, CompanyModelBinding>>
}

interface JevConfiguration {
  readonly baseUrl: string
  readonly endpoint?: string
  readonly secretRef: string
  readonly models: Readonly<Record<string, JevModelBinding>>
  readonly fallbackPolicy: JevFallbackPolicy
  readonly minConfidence?: number
}

const COMPANY_CAPABILITY: CoreModelCapabilityName = 'company_generation'
const JEV_CAPABILITY: CoreModelCapabilityName = 'jev_decision'
const FALLBACK_POLICIES: ReadonlySet<string> = new Set([
  'deterministic',
  'generative_classification',
  'clarify',
  'reject',
])

function isJevFallbackPolicy(value: string): value is JevFallbackPolicy {
  return FALLBACK_POLICIES.has(value)
}

function flagOf(
  env: Readonly<Record<string, string | undefined>>,
  setting: string,
): boolean {
  const value = env[setting]
  if (value === undefined || value === '') return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new CoreModelConfigurationError(
    'INVALID_FLAG',
    setting === 'CORE_ENABLE_JEV' ? JEV_CAPABILITY : COMPANY_CAPABILITY,
    `${setting} must be exactly "true" or "false"`,
    setting,
  )
}

function requiredSetting(
  env: Readonly<Record<string, string | undefined>>,
  capability: CoreModelCapabilityName,
  setting: string,
): string {
  const value = env[setting]?.trim()
  if (value === undefined || value.length === 0) {
    throw new CoreModelConfigurationError(
      'MISSING_SETTING',
      capability,
      `${setting} is required when ${capability} is enabled`,
      setting,
    )
  }
  return value
}

function optionalSetting(
  env: Readonly<Record<string, string | undefined>>,
  setting: string,
): string | undefined {
  const value = env[setting]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function baseUrlOf(value: string, capability: CoreModelCapabilityName, setting: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CoreModelConfigurationError(
      'INVALID_SETTING',
      capability,
      `${setting} must be an absolute HTTP(S) URL without credentials, path, query or fragment`,
      setting,
    )
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new CoreModelConfigurationError(
      'INVALID_SETTING',
      capability,
      `${setting} must be an absolute HTTP(S) origin without credentials, path, query or fragment`,
      setting,
    )
  }
  return url.origin
}

function endpointOf(
  env: Readonly<Record<string, string | undefined>>,
  capability: CoreModelCapabilityName,
  setting: string,
): string | undefined {
  const endpoint = optionalSetting(env, setting)
  if (endpoint === undefined) return undefined
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('?') || endpoint.includes('#')) {
    throw new CoreModelConfigurationError(
      'INVALID_SETTING',
      capability,
      `${setting} must be an absolute path without query or fragment`,
      setting,
    )
  }
  return endpoint
}

function companyProtocolOf(value: string): CompanyModelProtocol {
  if (value === 'private' || value === 'openai-compatible') return value
  throw new CoreModelConfigurationError(
    'INVALID_SETTING',
    COMPANY_CAPABILITY,
    'CORE_COMPANY_MODEL_PROTOCOL must be "private" or "openai-compatible"',
    'CORE_COMPANY_MODEL_PROTOCOL',
  )
}

function fallbackPolicyOf(value: string | undefined): JevFallbackPolicy {
  const policy = value ?? 'reject'
  if (isJevFallbackPolicy(policy)) return policy
  throw new CoreModelConfigurationError(
    'INVALID_SETTING',
    JEV_CAPABILITY,
    'CORE_JEV_FALLBACK_POLICY must be deterministic, generative_classification, clarify or reject',
    'CORE_JEV_FALLBACK_POLICY',
  )
}

function confidenceOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CoreModelConfigurationError(
      'INVALID_SETTING',
      JEV_CAPABILITY,
      'CORE_JEV_MIN_CONFIDENCE must be a number in [0, 1]',
      'CORE_JEV_MIN_CONFIDENCE',
    )
  }
  return parsed
}

function companyConfigurationOf(
  env: Readonly<Record<string, string | undefined>>,
): CompanyConfiguration {
  const platformModelId = requiredSetting(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_PLATFORM_ID')
  const vendorModel = requiredSetting(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_VENDOR_MODEL')
  const endpoint = endpointOf(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_ENDPOINT')
  return {
    baseUrl: baseUrlOf(
      requiredSetting(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_BASE_URL'),
      COMPANY_CAPABILITY,
      'CORE_COMPANY_MODEL_BASE_URL',
    ),
    secretRef: requiredSetting(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_SECRET_REF'),
    protocol: companyProtocolOf(requiredSetting(env, COMPANY_CAPABILITY, 'CORE_COMPANY_MODEL_PROTOCOL')),
    models: { [platformModelId]: { vendorModel } },
    ...(endpoint === undefined ? {} : { endpoint }),
  }
}

function jevConfigurationOf(env: Readonly<Record<string, string | undefined>>): JevConfiguration {
  const platformModelId = requiredSetting(env, JEV_CAPABILITY, 'CORE_JEV_PLATFORM_MODEL_ID')
  const vendorModel = requiredSetting(env, JEV_CAPABILITY, 'CORE_JEV_VENDOR_MODEL')
  const fallbackPolicy = fallbackPolicyOf(optionalSetting(env, 'CORE_JEV_FALLBACK_POLICY'))
  const endpoint = endpointOf(env, JEV_CAPABILITY, 'CORE_JEV_ENDPOINT')
  const minConfidence = confidenceOf(optionalSetting(env, 'CORE_JEV_MIN_CONFIDENCE'))
  return {
    baseUrl: baseUrlOf(
      requiredSetting(env, JEV_CAPABILITY, 'CORE_JEV_BASE_URL'),
      JEV_CAPABILITY,
      'CORE_JEV_BASE_URL',
    ),
    secretRef: requiredSetting(env, JEV_CAPABILITY, 'CORE_JEV_SECRET_REF'),
    models: { [platformModelId]: { vendorModel, fallbackPolicy } },
    fallbackPolicy,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
  }
}

/**
 * Parse the server-only model configuration once. Each execution then binds the existing
 * adapters to its already-opened ledger and its own cancellation signal. The factory does
 * not resolve secrets, open ledgers, send HTTP requests or select vendor models implicitly.
 */
export function createCoreModelCapabilityFactory(
  dependencies: CoreModelCapabilityFactoryDependencies,
): CoreModelCapabilityFactory {
  const generationEnabled = flagOf(dependencies.env, 'CORE_ENABLE_MODELS')
  const decisionEnabled = flagOf(dependencies.env, 'CORE_ENABLE_JEV')
  const company = generationEnabled ? companyConfigurationOf(dependencies.env) : undefined
  const jev = decisionEnabled ? jevConfigurationOf(dependencies.env) : undefined

  if (company !== undefined && dependencies.generationEvidence === undefined) {
    throw new CoreModelConfigurationError(
      'DEPENDENCY_NOT_CONFIGURED',
      COMPANY_CAPABILITY,
      'a generation evidence recorder is required when company generation is enabled',
    )
  }
  if (jev !== undefined && dependencies.decisionEvidence === undefined) {
    throw new CoreModelConfigurationError(
      'DEPENDENCY_NOT_CONFIGURED',
      JEV_CAPABILITY,
      'a decision evidence recorder is required when JEV is enabled',
    )
  }
  if (jev !== undefined && dependencies.decisionStateResolver === undefined) {
    throw new CoreModelConfigurationError(
      'DEPENDENCY_NOT_CONFIGURED',
      JEV_CAPABILITY,
      'an authorized actual-state resolver is required when JEV is enabled',
    )
  }
  if (jev?.fallbackPolicy === 'generative_classification' && dependencies.generativeClassification === undefined) {
    throw new CoreModelConfigurationError(
      'DEPENDENCY_NOT_CONFIGURED',
      JEV_CAPABILITY,
      'a generative-classification fallback port is required by CORE_JEV_FALLBACK_POLICY',
      'CORE_JEV_FALLBACK_POLICY',
    )
  }

  return {
    generationEnabled,
    decisionEnabled,
    forExecution(context) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(context.ledgerId) ||
        typeof context.signal?.aborted !== 'boolean' ||
        typeof context.signal.addEventListener !== 'function'
      ) {
        throw new CoreModelConfigurationError(
          'INVALID_SETTING',
          'factory',
          'model capabilities require a real ledger id and AbortSignal for the execution',
        )
      }
      const generation = company === undefined
        ? undefined
        : new CompanyGenerationAdapter({
            ...company,
            secrets: dependencies.secrets,
            budget: dependencies.budget,
            ledgerId: context.ledgerId,
            evidence: dependencies.generationEvidence ?? missingGenerationEvidence(),
            ...(dependencies.schemaValidator === undefined ? {} : { schemaValidator: dependencies.schemaValidator }),
            signal: context.signal,
            ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
          })
      const decision = jev === undefined
        ? undefined
        : new JevDecisionAdapter({
            ...jev,
            secrets: dependencies.secrets,
            budget: dependencies.budget,
            ledgerId: context.ledgerId,
            evidence: dependencies.decisionEvidence ?? missingDecisionEvidence(),
            stateResolver: dependencies.decisionStateResolver ?? missingDecisionStateResolver(),
            signal: context.signal,
            ...(dependencies.generativeClassification === undefined
              ? {}
              : { generativeClassification: dependencies.generativeClassification }),
            ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
          })
      return {
        ...(generation === undefined ? {} : { generation }),
        ...(decision === undefined ? {} : { decision }),
      }
    },
  }
}

function missingGenerationEvidence(): ModelCallEvidenceRecorder {
  throw new CoreModelConfigurationError(
    'DEPENDENCY_NOT_CONFIGURED',
    COMPANY_CAPABILITY,
    'a generation evidence recorder is required when company generation is enabled',
  )
}

function missingDecisionEvidence(): DecisionEvidenceRecorder {
  throw new CoreModelConfigurationError(
    'DEPENDENCY_NOT_CONFIGURED',
    JEV_CAPABILITY,
    'a decision evidence recorder is required when JEV is enabled',
  )
}

function missingDecisionStateResolver(): JevActualStateResolver {
  throw new CoreModelConfigurationError(
    'DEPENDENCY_NOT_CONFIGURED',
    JEV_CAPABILITY,
    'an authorized actual-state resolver is required when JEV is enabled',
  )
}
