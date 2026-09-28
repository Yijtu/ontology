import type {
  OntologyConceptRef,
  OntologyLookupInput,
  OntologyLookupIntent,
  OntologyLookupOutput,
  ResourceRef,
  ScopeRef,
  SourceRef,
  TimeContext,
  ToolCoverage,
  ValidityInterval,
} from '@ontology/contracts'
import type { OntologyLookupService } from '@ontology/semantic-engine'
import { ToolGatewayError } from '../errors'
import type { ToolExecutionOutcome, ToolExecutionRequest, ToolHandler } from '../types'

/**
 * `ontology_lookup` handler (C4). It reads the local, visible definitions/mappings/facts
 * through the injected `OntologyLookupService` and reports pagination honestly through
 * `ToolCoverage`. It never publishes anything: the service only reads, and the result
 * carries `autoPublished: false`.
 */
export interface OntologyLookupHandlerConfig {
  readonly lookup: OntologyLookupService
  /** The control/semantic store this lookup read from; never fabricated by the handler. */
  readonly sourceRef: SourceRef
}

const INTENTS: readonly OntologyLookupIntent[] = ['definitions', 'resolve', 'relations', 'rules', 'facts']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readScopeRef(value: unknown): ScopeRef {
  if (!isRecord(value) || typeof value.tenantId !== 'string' || typeof value.spaceId !== 'string') {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'ontology_lookup requires a scopeRef{tenantId,spaceId}')
  }
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    ...(typeof value.namespace === 'string' ? { namespace: value.namespace } : {}),
  }
}

function readConcepts(value: unknown): OntologyConceptRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'concepts must be an array')
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.namespace !== 'string' ||
      typeof entry.conceptId !== 'string'
    ) {
      throw new ToolGatewayError('INVALID_ARGUMENTS', 'each concept requires namespace and conceptId')
    }
    return {
      namespace: entry.namespace,
      conceptId: entry.conceptId,
      ...(typeof entry.definitionVersion === 'string'
        ? { definitionVersion: entry.definitionVersion }
        : {}),
    }
  })
}

function readEntityRefs(value: unknown): ResourceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'entityRefs must be an array')
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.version !== 'string' ||
      typeof entry.digest !== 'string' ||
      typeof entry.kind !== 'string'
    ) {
      throw new ToolGatewayError('INVALID_ARGUMENTS', 'each entityRef must be a full ResourceRef')
    }
    return {
      id: entry.id,
      version: entry.version,
      digest: entry.digest,
      kind: entry.kind as ResourceRef['kind'],
    }
  })
}

function readTimeContext(value: unknown): TimeContext | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.asOf !== 'string' || typeof value.timeZone !== 'string') {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'timeContext requires asOf and timeZone')
  }
  return {
    asOf: value.asOf,
    timeZone: value.timeZone,
    ...(typeof value.validAt === 'string' ? { validAt: value.validAt } : {}),
  }
}

function parseLookupInput(args: Readonly<Record<string, unknown>>): OntologyLookupInput {
  const intent = args.intent
  if (typeof intent !== 'string' || !INTENTS.includes(intent as OntologyLookupIntent)) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'ontology_lookup requires a valid intent')
  }
  const concepts = readConcepts(args.concepts)
  const entityRefs = readEntityRefs(args.entityRefs)
  const timeContext = readTimeContext(args.timeContext)
  return {
    scopeRef: readScopeRef(args.scopeRef),
    intent: intent as OntologyLookupIntent,
    ...(concepts.length === 0 ? {} : { concepts }),
    ...(entityRefs.length === 0 ? {} : { entityRefs }),
    ...(timeContext === undefined ? {} : { timeContext }),
    ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  }
}

function commonFactValidity(items: OntologyLookupOutput['items']): ValidityInterval | undefined {
  const intervals = items.filter((item) => item.kind === 'fact').map((item) => item.validity)
  if (intervals.length === 0 || intervals.some((interval) => interval === undefined)) return undefined
  const defined = intervals.filter((interval): interval is ValidityInterval => interval !== undefined)
  let validFrom = defined[0]?.validFrom
  let validTo: string | undefined
  for (const interval of defined) {
    const fromMs = Date.parse(interval.validFrom)
    const toMs = interval.validTo === undefined ? undefined : Date.parse(interval.validTo)
    if (!Number.isFinite(fromMs) || (toMs !== undefined && !Number.isFinite(toMs))) {
      throw new ToolGatewayError('OUTCOME_INVALID', 'a published fact carries invalid validity timestamps')
    }
    if (validFrom === undefined || fromMs > Date.parse(validFrom)) validFrom = interval.validFrom
    if (interval.validTo !== undefined && (validTo === undefined || toMs !== undefined && toMs < Date.parse(validTo))) {
      validTo = interval.validTo
    }
  }
  if (validFrom === undefined) return undefined
  if (validTo !== undefined && Date.parse(validFrom) >= Date.parse(validTo)) {
    throw new ToolGatewayError('OUTCOME_INVALID', 'published fact rows do not share one valid-time interval')
  }
  return { validFrom, ...(validTo === undefined ? {} : { validTo }) }
}

export class OntologyLookupHandler implements ToolHandler {
  readonly toolId = 'ontology_lookup'
  readonly #config: OntologyLookupHandlerConfig

  constructor(config: OntologyLookupHandlerConfig) {
    this.#config = config
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const input = parseLookupInput(request.arguments)
    const page = await this.#config.lookup.lookup(input, request.ctx)
    const truncated = page.nextCursor !== null
    const output = input.intent === 'facts' && truncated
      ? { ...page.output, gaps: [...page.output.gaps, 'facts_uncovered:result_page_truncated'] }
      : page.output
    const validity = input.intent === 'facts' ? commonFactValidity(output.items) : undefined
    const coverage: ToolCoverage = {
      returned: output.items.length,
      truncated,
      ...(page.nextCursor === null ? {} : { cursor: page.nextCursor }),
      completeness: page.completeness,
    }
    return {
      payload: output,
      status: truncated ? 'partial' : output.items.length === 0 ? 'empty' : 'ok',
      ...(validity === undefined ? {} : { validity }),
      coverage,
      sources: [
        {
          sourceRef: this.#config.sourceRef,
          schemaVersion: page.output.definitionVersion.digest,
          consistency: 'repeatable_read',
          resultDigest: page.output.definitionVersion.digest,
        },
      ],
      usage: { rows: page.output.items.length },
    }
  }
}
