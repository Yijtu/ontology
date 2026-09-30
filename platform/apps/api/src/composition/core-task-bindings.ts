import type {
  PublishedTaskBinding,
  PublishedTaskBindingBody,
  ScopeRef,
  TaskBindingStore,
  TaskKind,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  EXAMPLE_OPERATION_REF,
  canonicalJson,
  exampleRegisteredOperation,
  registeredOperationDigest,
} from '@ontology/tool-services'
import type { CoreExampleScenario } from './core-example-loader'
import { CORE_TYPED_RESULT_SCHEMA_REF } from './core-local-composition'

/**
 * The runnable task bindings the default Core host mounts for every scenario (SPEC v0.3a
 * §EX-2.1/§EX-3.1). Each binding is a declarative record: it names the task kind, the exact
 * parameter schema, the capabilities/readiness it needs and the registered result format the
 * host can render. It carries no executable code, no endpoint and no industry token — the
 * concrete handlers reach it only through the run's resolved profile and the shared gateway.
 *
 * The host always mounts one binding per (definition, kind). The binding digest covers the
 * scenario definition, so two scenarios never collide in the store even though the id/version
 * are shared. Mounting is idempotent: the exact same record is a no-op, a different body under
 * the same ref is refused by the store.
 */

const BINDING_VERSION = '1.0.0'
const CONTRACT_SCHEMA_BASE = 'https://ontology.local/schema'
const CORE_TASK_ID = (kind: TaskKind): string => `core.task.${kind}`

function parameterSchemaOf(kind: TaskKind): Readonly<Record<string, unknown>> {
  switch (kind) {
    case 'published_facts':
      return { type: 'object', additionalProperties: false, properties: {} }
    case 'rule_judgement':
      // A rule judgement names the exact already-materialized instance it must derive: the
      // reviewed rule version, the mounted definition, the subject/object identity and the
      // bitemporal point. Nothing here is model-authored at run time — the fixed plan copies
      // these host-approved parameters into the typed lookup request.
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          ruleRef: { $ref: `${CONTRACT_SCHEMA_BASE}/common.schema.json#/$defs/VersionRef` },
          objectId: { type: 'string', minLength: 1 },
          subjectEntityId: { type: 'string', minLength: 1 },
          validAt: { $ref: `${CONTRACT_SCHEMA_BASE}/common.schema.json#/$defs/Rfc3339UtcTimestamp` },
          asOfRecordedSeq: { type: 'string', minLength: 1 },
          judgementAxis: { type: 'string', enum: ['applicability', 'business_proposition'] },
        },
        required: ['ruleRef', 'objectId', 'subjectEntityId', 'validAt', 'asOfRecordedSeq'],
      }
    case 'relations':
      return {
        type: 'object',
        additionalProperties: false,
        properties: { question: { type: 'string' } },
        required: ['question'],
      }
    case 'structured_query':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectId: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer' },
        },
        required: ['objectId', 'fields'],
      }
    case 'document_qa':
      return {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
      }
    case 'compute':
      return { type: 'object', additionalProperties: false, properties: {} }
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled task kind ${String(exhaustive)}`)
    }
  }
}

function requiredCapabilitiesOf(kind: TaskKind): readonly string[] {
  switch (kind) {
    case 'structured_query':
      return ['structured_query']
    case 'document_qa':
      return ['document_search']
    // `published_facts` reads through ontology_lookup, `rule_judgement` through the published
    // rule definitions and `compute` through the registered operation pin; none declares a
    // deployment capability the generic Core does not already resolve for every scenario.
    case 'published_facts':
    case 'rule_judgement':
    case 'relations':
    case 'compute':
      return []
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled task kind ${String(exhaustive)}`)
    }
  }
}

function requiredReadinessOf(kind: TaskKind): readonly ('published_semantics' | 'dataset' | 'document_index')[] {
  switch (kind) {
    case 'structured_query':
      return ['dataset']
    case 'document_qa':
      return ['document_index']
    case 'rule_judgement':
    case 'relations':
      return ['published_semantics']
    case 'published_facts':
    case 'compute':
      return []
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled task kind ${String(exhaustive)}`)
    }
  }
}

function bodyFor(
  scenario: CoreExampleScenario,
  kind: TaskKind,
): PublishedTaskBindingBody {
  const parameterSchema = parameterSchemaOf(kind)
  const operationRef = kind === 'compute' ? EXAMPLE_OPERATION_REF : undefined
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingIdentity: { id: CORE_TASK_ID(kind), version: BINDING_VERSION },
    actionDefinitionRef: scenario.definitionRef,
    kind,
    parameterSchema: { ...parameterSchema },
    parameterSchemaDigest: sha256DigestOf(canonicalJson(parameterSchema)),
    requiredCapabilities: [...requiredCapabilitiesOf(kind)],
    requiredReadiness: [...requiredReadinessOf(kind)],
    resultSchemaRef: CORE_TYPED_RESULT_SCHEMA_REF,
    ...(operationRef === undefined ? {} : { operationRef }),
    ...(operationRef === undefined
      ? {}
      : { registeredOperationDigest: registeredOperationDigest(exampleRegisteredOperation()) }),
  }
}

/** Build one flat published-task-binding envelope from its canonical hash body. */
function bindingOf(body: PublishedTaskBindingBody): PublishedTaskBinding {
  return {
    schemaVersion: body.schemaVersion,
    taskBindingRef: {
      id: body.taskBindingIdentity.id,
      version: body.taskBindingIdentity.version,
      digest: sha256DigestOf(canonicalJson(body)),
    },
    actionDefinitionRef: body.actionDefinitionRef,
    kind: body.kind,
    parameterSchema: body.parameterSchema,
    parameterSchemaDigest: body.parameterSchemaDigest,
    requiredCapabilities: [...body.requiredCapabilities],
    requiredReadiness: [...body.requiredReadiness],
    resultSchemaRef: body.resultSchemaRef,
    ...(body.operationRef === undefined ? {} : { operationRef: body.operationRef }),
    ...(body.registeredOperationDigest === undefined
      ? {}
      : { registeredOperationDigest: body.registeredOperationDigest }),
    ...(body.validationPolicies === undefined ? {} : { validationPolicies: [...body.validationPolicies] }),
    ...(body.fixedPlanRef === undefined ? {} : { fixedPlanRef: body.fixedPlanRef }),
  }
}

/** The runnable task bindings mounted for one scenario, in a stable order. */
export const CORE_MOUNTED_TASK_KINDS: readonly TaskKind[] = [
  'published_facts',
  'structured_query',
  'document_qa',
  'rule_judgement',
  'compute',
]

export function coreScenarioTaskBindings(scenario: CoreExampleScenario): readonly PublishedTaskBinding[] {
  return CORE_MOUNTED_TASK_KINDS.map((kind) => bindingOf(bodyFor(scenario, kind)))
}

/** The exact binding ref the host mounts for one (scenario, kind); deterministic and reusable. */
export function coreTaskBindingRef(scenario: CoreExampleScenario, kind: TaskKind): VersionRef {
  return bindingOf(bodyFor(scenario, kind)).taskBindingRef
}

/**
 * Mount every scenario's runnable task bindings. Idempotent per exact record; a conflicting
 * body for an already-mounted ref is refused by the store rather than overwritten.
 */
export async function mountCoreTaskBindings(
  store: TaskBindingStore,
  scenarios: readonly CoreExampleScenario[],
  scopeRef: ScopeRef,
  ctx: ToolContext,
): Promise<void> {
  for (const scenario of scenarios) {
    for (const binding of coreScenarioTaskBindings(scenario)) {
      const existing = await store.getBinding(scopeRef, binding.taskBindingRef, ctx)
      if (existing !== undefined) continue
      await store.putBinding(scopeRef, binding, ctx)
    }
  }
}
