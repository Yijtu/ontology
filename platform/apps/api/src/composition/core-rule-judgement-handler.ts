import { isToolContext } from '@ontology/contracts'
import type {
  OntologyRuleJudgementRequest,
  ScopeRef,
  SourceRef,
  ToolContext,
} from '@ontology/contracts'
import {
  ToolGatewayError,
  isRecord,
} from '@ontology/tool-services'
import type {
  OntologyLookupHandler,
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolHandler,
} from '@ontology/tool-services'
import type { MaterializedRuleDerivationEvidenceProducer } from '@ontology/semantic-engine'

/**
 * The Core `ontology_lookup` handler (SPEC v0.3a §EX-3.1, §EX-5).
 *
 * The canonical four model tools stay closed: this handler owns the single `ontology_lookup`
 * tool id and dispatches the typed `intent=rules` request to the materialised rule-derivation
 * evidence producer, delegating every other intent to the ordinary lookup handler. The
 * producer runs as a run-scoped evidence step — never a manual controller start — and the
 * derived `rule_derivation` support payload is returned as the tool result, so the gateway
 * archives it under a publication-safe envelope whose digest covers the archived bytes.
 *
 * The request the model may propose carries only semantic refs (rule/definition/subject and the
 * bitemporal point). It can never name a handler, a column, a table or a script.
 */

export interface RuleDerivationRequestReader {
  readonly scopeRef: ScopeRef
  readonly request: OntologyRuleJudgementRequest
}

export interface CoreOntologyLookupHandlerDependencies {
  /** The ordinary definitions/facts/relations lookup path, unchanged. */
  readonly lookup: OntologyLookupHandler
  readonly producer: MaterializedRuleDerivationEvidenceProducer
  /** The control/semantic store the rule derivation read from; never fabricated here. */
  readonly sourceRef: SourceRef
}

function trustScope(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ToolGatewayError('UNTRUSTED_CONTEXT', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ToolGatewayError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function readVersionRef(value: unknown): { id: string; version: string; digest: string } | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const version = value['version']
  const digest = value['digest']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) return undefined
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) return undefined
  return { id, version, digest }
}

/** Read the typed rule-judgement request the fixed plan mounted; fail closed on any gap. */
export function readRuleJudgementRequest(
  args: Readonly<Record<string, unknown>>,
): OntologyRuleJudgementRequest | undefined {
  const raw = args['request']
  if (!isRecord(raw) || raw['kind'] !== 'rule_judgement') return undefined
  const ruleRef = readVersionRef(raw['ruleRef'])
  const definitionRef = readVersionRef(raw['definitionRef'])
  const objectId = raw['objectId']
  const subjectEntityId = raw['subjectEntityId']
  const validAt = raw['validAt']
  const asOfRecordedSeq = raw['asOfRecordedSeq']
  const axis = raw['judgementAxis']
  if (ruleRef === undefined || definitionRef === undefined) return undefined
  if (typeof objectId !== 'string' || objectId.length === 0) return undefined
  if (typeof subjectEntityId !== 'string' || subjectEntityId.length === 0) return undefined
  if (typeof validAt !== 'string' || validAt.length === 0) return undefined
  if (typeof asOfRecordedSeq !== 'string' || asOfRecordedSeq.length === 0) return undefined
  if (axis !== undefined && axis !== 'applicability' && axis !== 'business_proposition') return undefined
  return {
    kind: 'rule_judgement',
    ruleRef,
    definitionRef,
    objectId,
    subjectEntityId,
    validAt,
    asOfRecordedSeq,
    ...(axis === undefined ? {} : { judgementAxis: axis }),
  }
}

export class CoreOntologyLookupHandler implements ToolHandler {
  readonly toolId = 'ontology_lookup'
  readonly #dependencies: CoreOntologyLookupHandlerDependencies

  constructor(dependencies: CoreOntologyLookupHandlerDependencies) {
    this.#dependencies = dependencies
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const ruleRequest = request.arguments['intent'] === 'rules'
      ? readRuleJudgementRequest(request.arguments)
      : undefined
    if (ruleRequest === undefined) return this.#dependencies.lookup.execute(request)
    return this.#deriveRule(request, ruleRequest)
  }

  async #deriveRule(
    request: ToolExecutionRequest,
    ruleRequest: OntologyRuleJudgementRequest,
  ): Promise<ToolExecutionOutcome> {
    const scopeRef = trustScope(request.ctx)
    const trust = request.arguments['scopeRef']
    if (isRecord(trust) && (trust['tenantId'] !== scopeRef.tenantId || trust['spaceId'] !== scopeRef.spaceId)) {
      throw new ToolGatewayError('SCOPE_MISMATCH', 'the requested rule scope is outside the trusted context scope')
    }
    const record = await this.#dependencies.producer.record(
      {
        scopeRef,
        ruleRef: ruleRequest.ruleRef,
        definitionRef: ruleRequest.definitionRef,
        objectId: ruleRequest.objectId,
        subjectEntityId: ruleRequest.subjectEntityId,
        validAt: ruleRequest.validAt,
        asOfRecordedSeq: ruleRequest.asOfRecordedSeq,
        observedAt: new Date().toISOString(),
        sourceSnapshots: [],
        dataMode: 'observed',
      },
      request.ctx,
    )
    if (record.envelope.payloadRef === undefined) {
      throw new ToolGatewayError('OUTCOME_INVALID', 'the rule-derivation evidence archived no support payload')
    }
    // The derived `rule_derivation` envelope (with its ruleRef and archived support payload) is
    // declared as the result's lineage. The gateway re-checks it and the typed writer renders the
    // rule judgement from it; this handler's own result body is only a locator hint.
    return {
      payload: { ruleRef: ruleRequest.ruleRef, supportEvidenceId: record.evidenceRef.id },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [
        {
          sourceRef: this.#dependencies.sourceRef,
          schemaVersion: ruleRequest.definitionRef.digest,
          consistency: 'repeatable_read',
          resultDigest: record.envelope.resultDigest,
        },
      ],
      dataMode: 'observed',
      supportEvidenceRefs: [record.evidenceRef],
    }
  }
}

/** The composition entrypoint: one `ontology_lookup` handler over the lookup + rule producer. */
export function createCoreOntologyLookupHandler(
  dependencies: CoreOntologyLookupHandlerDependencies,
): ToolHandler {
  return new CoreOntologyLookupHandler(dependencies)
}
