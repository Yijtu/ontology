import type {
  EntityCandidate,
  IndustrySchema,
  RuleCandidate,
  RuleUnhandledCandidate,
  VersionRef,
} from '@ontology/contracts'

export const PUBLICATION_DEFINITION_REF: VersionRef = {
  id: 'home-energy.core',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

export const PUBLICATION_PARSE_ID = '99999999-9999-4999-8999-999999999999'
export const PUBLICATION_JOB_ID = '88888888-8888-4888-8888-888888888888'

/** A definition with a `device` object and a matching identity scope. */
export function publicationSchema(ref: VersionRef): IndustrySchema {
  return {
    namespace: 'home-energy',
    definitionRef: ref,
    objects: [
      {
        objectId: 'device',
        displayName: 'Device',
        identityScopeId: 'device_identity',
        attributes: [
          { attributeId: 'device_native_id', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'device_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
          { attributeId: 'site', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: false },
          { attributeId: 'device.battery_present', valueType: 'boolean', minCardinality: 0, maxCardinality: 1, identityKey: false },
          { attributeId: 'device.battery_absent', valueType: 'boolean', minCardinality: 0, maxCardinality: 1, identityKey: false },
        ],
      },
    ],
    relations: [],
    identityScopes: [
      {
        identityScopeId: 'device_identity',
        objectId: 'device',
        scopeDimensions: ['site'],
        identityAttributeIds: ['device_native_id'],
      },
    ],
  }
}

export function publicationSpan(seed: string): EntityCandidate['sourceSpans'][number] {
  return {
    parseId: PUBLICATION_PARSE_ID,
    chunkId: seed,
    locator: { kind: 'offset', startOffset: 0, endOffset: 8 },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: `sha256:${'6'.repeat(64)}`,
    textDigest: `sha256:${'7'.repeat(64)}`,
  }
}

export function entityFor(
  overrides: Partial<EntityCandidate> & { readonly candidateId: string; readonly idempotencyKey: string },
): EntityCandidate {
  const candidateId = overrides.candidateId
  return {
    kind: 'entity',
    jobId: PUBLICATION_JOB_ID,
    objectId: 'device',
    identityScopeId: 'device_identity',
    attributes: [
      { attributeId: 'device_native_id', value: `DEV-${candidateId.slice(0, 4)}` },
      { attributeId: 'device_name', value: 'Charger One' },
      { attributeId: 'site', value: 'site-a' },
    ],
    sourceSpans: [publicationSpan(candidateId)],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId: PUBLICATION_PARSE_ID,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    recordedAt: '2026-09-22T00:00:00Z',
    ...overrides,
    candidateId,
    idempotencyKey: overrides.idempotencyKey,
  }
}

export function ruleFor(
  overrides: Partial<RuleCandidate> & { readonly candidateId: string; readonly idempotencyKey: string },
): RuleCandidate {
  const candidateId = overrides.candidateId
  return {
    kind: 'rule',
    jobId: PUBLICATION_JOB_ID,
    ruleId: 'device_power_limit',
    objectId: 'device',
    severity: 'soft',
    impact: 'low',
    reviewRequirement: 'policy_eligible',
    expression: {
      op: 'compare',
      attributeId: 'device_name',
      operator: 'eq',
      value: 'Charger One',
      spans: [],
    },
    exceptions: [],
    conflicts: [],
    sourceSpans: [publicationSpan(candidateId)],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId: PUBLICATION_PARSE_ID,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    recordedAt: '2026-09-22T00:00:00Z',
    ...overrides,
    candidateId,
    idempotencyKey: overrides.idempotencyKey,
  }
}

export function unhandledRuleFor(
  overrides: Partial<RuleUnhandledCandidate> & {
    readonly candidateId: string
    readonly idempotencyKey: string
  },
): RuleUnhandledCandidate {
  const candidateId = overrides.candidateId
  return {
    kind: 'rule_unhandled',
    jobId: PUBLICATION_JOB_ID,
    ruleId: 'device_power_limit',
    reason: 'UNSUPPORTED_QUANTIFIER',
    detail: 'the source used an aggregate the bounded AST cannot represent',
    rawExpression: '{"op":"sum","of":"device_name"}',
    sourceSpans: [publicationSpan(candidateId)],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId: PUBLICATION_PARSE_ID,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    recordedAt: '2026-09-22T00:00:00Z',
    ...overrides,
    candidateId,
    idempotencyKey: overrides.idempotencyKey,
  }
}
