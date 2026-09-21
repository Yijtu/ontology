import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  InMemorySemanticDefinitionStore,
  SemanticDefinitionError,
  SemanticDefinitionService,
  definitionRecordOf,
  definitionVersionDigest,
  scanDefinitionPurity,
  validateDefinitionVersion,
} from '@ontology/semantic-engine'
import type {
  AttributeDefinition,
  IdentityScopeDefinition,
  ObjectDefinition,
  RelationDefinition,
  RuleConstraintDefinition,
  SemanticDefinitionVersionDraft,
} from '@ontology/semantic-engine'
import {
  CORE_DEFINITION_ID,
  DATA_REF_ID,
  DIGEST_B,
  NAMESPACE,
  RecordingControlRepository,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  dataRef,
  fixedClock,
  provenance,
  sampleCoreDraft,
  sampleExtensionDraft,
  toolContext,
} from './semantic-definition-fixtures'

const SCOPE_A = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B = { tenantId: TENANT_B, spaceId: SPACE_B }
const ADMIN_A = toolContext(TENANT_A, SPACE_A, ['platform-admin'], 'semantic-admin')
const ADMIN_B = toolContext(TENANT_B, SPACE_B, ['platform-admin'], 'semantic-admin-b')
const RUNNER_A = toolContext(TENANT_A, SPACE_A, ['run-controller'], 'semantic-runner')

interface Harness {
  readonly service: SemanticDefinitionService
  readonly store: InMemorySemanticDefinitionStore
  readonly control: RecordingControlRepository
}

function buildService(): Harness {
  const store = new InMemorySemanticDefinitionStore()
  const control = new RecordingControlRepository()
  const service = new SemanticDefinitionService({ control, store, now: fixedClock() })
  return { service, store, control }
}

async function captureError(run: () => Promise<unknown>): Promise<SemanticDefinitionError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SemanticDefinitionError) return error
    throw error
  }
  throw new Error('expected the definition call to fail')
}

function core(): SemanticDefinitionVersionDraft {
  return sampleCoreDraft()
}

function replaceAttribute(id: string, replacement: AttributeDefinition): AttributeDefinition[] {
  return core().attributes.map((attribute) => (attribute.id === id ? replacement : attribute))
}

function replaceObject(id: string, replacement: ObjectDefinition): ObjectDefinition[] {
  return core().objects.map((object) => (object.id === id ? replacement : object))
}

function replaceScope(id: string, replacement: IdentityScopeDefinition): IdentityScopeDefinition[] {
  return core().identityScopes.map((scope) => (scope.id === id ? replacement : scope))
}

describe('semantic definition publication (unit)', () => {
  it('publishes a valid definition set, records one audit event and resolves it', async () => {
    const { service, control } = buildService()
    const draft = core()

    const published = await service.publish(draft, ADMIN_A)
    expect(published.ref).toEqual({
      id: CORE_DEFINITION_ID,
      version: '1.0.0',
      digest: definitionVersionDigest(draft),
    })
    expect(published.ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(published.publishedAt).toBe('2026-09-21T00:00:00.000Z')

    const stored = await service.getVersion(
      { scopeRef: SCOPE_A, namespace: NAMESPACE, definitionId: CORE_DEFINITION_ID, version: '1.0.0' },
      ADMIN_A,
    )
    expect(stored.ref.digest).toBe(published.ref.digest)
    expect(stored.attributes).toHaveLength(6)
    expect(stored.ruleConstraints).toHaveLength(3)

    const visible = await service.listVersions(SCOPE_A, { namespace: NAMESPACE }, ADMIN_A)
    expect(visible.map((version) => version.ref.id)).toEqual([CORE_DEFINITION_ID])

    const trail = await service.getAuditTrail(SCOPE_A, CORE_DEFINITION_ID, ADMIN_A)
    expect(trail).toHaveLength(1)
    expect(trail[0]?.seq).toBe(1)
    expect(trail[0]?.digest).toBe(published.ref.digest)
    expect(control.appended).toHaveLength(1)
    expect(control.appended[0]?.idempotencyKey).toBe(
      `definition-publish:${NAMESPACE}:${CORE_DEFINITION_ID}:1.0.0`,
    )
  })

  it('treats an identical re-publication as idempotent and keeps one audit event', async () => {
    const { service, control } = buildService()
    const first = await service.publish(core(), ADMIN_A)
    const second = await service.publish(core(), ADMIN_A)
    expect(second.publishedAt).toBe(first.publishedAt)
    expect(control.appended).toHaveLength(1)
    expect(await service.getAuditTrail(SCOPE_A, CORE_DEFINITION_ID, ADMIN_A)).toHaveLength(1)
  })

  it('rejects the same id+version with different content and never overwrites it', async () => {
    const { service } = buildService()
    const first = await service.publish(core(), ADMIN_A)

    const kindAttribute = core().attributes.find((attribute) => attribute.id === 'device_kind')
    if (kindAttribute === undefined) throw new Error('fixture is missing device_kind')
    const changed = sampleCoreDraft({
      attributes: replaceAttribute('device_kind', {
        ...kindAttribute,
        enumValues: ['charger', 'inverter', 'v2g'],
      }),
    })
    const error = await captureError(() => service.publish(changed, ADMIN_A))
    expect(error.code).toBe('DEFINITION_VERSION_CONFLICT')

    const stored = await service.getVersion(
      { scopeRef: SCOPE_A, namespace: NAMESPACE, definitionId: CORE_DEFINITION_ID, version: '1.0.0' },
      ADMIN_A,
    )
    expect(stored.ref.digest).toBe(first.ref.digest)
  })

  it('keeps the persisted declaration free of the trusted scope', async () => {
    const { service } = buildService()
    const published = await service.publish(core(), ADMIN_A)
    const record = definitionRecordOf(published)
    expect('scopeRef' in record).toBe(false)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(TENANT_A)
    expect(serialized).not.toContain(SPACE_A)
  })

  it('isolates versions inside the tenant/space boundary', async () => {
    const { service } = buildService()
    await service.publish(core(), ADMIN_A)

    expect(await service.listVersions(SCOPE_B, {}, ADMIN_B)).toEqual([])
    const missing = await captureError(() =>
      service.getVersion(
        { scopeRef: SCOPE_B, namespace: NAMESPACE, definitionId: CORE_DEFINITION_ID, version: '1.0.0' },
        ADMIN_B,
      ),
    )
    expect(missing.code).toBe('DEFINITION_NOT_FOUND')

    const crossScope = await captureError(() => service.publish(core(), ADMIN_B))
    expect(crossScope.code).toBe('SCOPE_MISMATCH')

    const forbidden = await captureError(() => service.publish(core(), RUNNER_A))
    expect(forbidden.code).toBe('FORBIDDEN')
  })
})

describe('semantic definition validation (unit)', () => {
  it('accepts the reference definition set with no issues', () => {
    expect(validateDefinitionVersion(core())).toEqual([])
  })

  it('reports malformed structural input with typed issues instead of throwing', () => {
    const nonArray = Object.assign(core(), { objects: 'not-an-array' })
    expect(validateDefinitionVersion(nonArray).some((issue) => issue.code === 'INVALID_IDENTIFIER')).toBe(true)

    const nullEntry = Object.assign(core(), { attributes: [null] })
    expect(validateDefinitionVersion(nullEntry).some((issue) => issue.code === 'INVALID_IDENTIFIER')).toBe(true)
  })

  it('fails publication for a rule constraint referencing an undefined attribute', async () => {
    const { service, store } = buildService()
    const dangling: RuleConstraintDefinition = {
      ...core().ruleConstraints[0]!,
      id: 'dangling_attribute_rule',
      expression: { op: 'compare', attributeId: 'does_not_exist', operator: 'eq', value: 'x' },
    }
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ ruleConstraints: [...core().ruleConstraints, dangling] }), ADMIN_A),
    )
    expect(error.code).toBe('INVALID_DEFINITION')
    expect(error.issues?.some((issue) => issue.code === 'RULE_REFERENCE_UNKNOWN')).toBe(true)
    expect(await store.listVersions(SCOPE_A, {}, ADMIN_A)).toEqual([])
  })

  it('fails publication for rule references to an undefined relation and object', async () => {
    const { service } = buildService()
    const relationRule: RuleConstraintDefinition = {
      ...core().ruleConstraints[0]!,
      id: 'dangling_relation_rule',
      expression: { op: 'relation', relationId: 'no_such_relation' },
    }
    const objectRule: RuleConstraintDefinition = {
      ...core().ruleConstraints[0]!,
      id: 'dangling_object_rule',
      objectId: 'no_such_object',
    }
    const error = await captureError(() =>
      service.publish(
        sampleCoreDraft({ ruleConstraints: [...core().ruleConstraints, relationRule, objectRule] }),
        ADMIN_A,
      ),
    )
    const codes = error.issues?.map((issue) => issue.code) ?? []
    expect(codes.filter((code) => code === 'RULE_REFERENCE_UNKNOWN')).toHaveLength(2)
  })

  it('fails publication for a dangling attribute object and relation endpoint', async () => {
    const { service } = buildService()
    const danglingAttribute: AttributeDefinition = {
      ...core().attributes[1]!,
      id: 'orphan_attribute',
      objectId: 'missing_object',
    }
    const danglingRelation: RelationDefinition = {
      ...core().relations[0]!,
      id: 'orphan_relation',
      toObjectId: 'missing_object',
    }
    const error = await captureError(() =>
      service.publish(
        sampleCoreDraft({
          attributes: [...core().attributes, danglingAttribute],
          relations: [...core().relations, danglingRelation],
        }),
        ADMIN_A,
      ),
    )
    const codes = error.issues?.map((issue) => issue.code) ?? []
    expect(codes).toContain('ATTRIBUTE_OBJECT_UNKNOWN')
    expect(codes).toContain('RELATION_ENDPOINT_UNKNOWN')
  })

  it('fails publication when an object references a missing identity scope', async () => {
    const { service } = buildService()
    const orphan: ObjectDefinition = {
      ...core().objects[0]!,
      id: 'orphan_object',
      identityScopeId: 'missing_scope',
    }
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ objects: [...core().objects, orphan] }), ADMIN_A),
    )
    expect(error.issues?.some((issue) => issue.code === 'IDENTITY_SCOPE_UNKNOWN')).toBe(true)
  })

  it('fails publication when an identity scope references an unknown attribute', async () => {
    const { service } = buildService()
    const broken = replaceScope('device_identity', {
      ...core().identityScopes[0]!,
      identityAttributeIds: ['missing_attribute'],
    })
    const error = await captureError(() => service.publish(sampleCoreDraft({ identityScopes: broken }), ADMIN_A))
    expect(error.issues?.some((issue) => issue.code === 'IDENTITY_SCOPE_ATTRIBUTE_UNKNOWN')).toBe(true)
  })

  it('rejects an ill-formed cardinality', async () => {
    const { service } = buildService()
    const broken = replaceAttribute('device_name', {
      ...core().attributes[1]!,
      cardinality: { min: 3, max: 1 },
    })
    const error = await captureError(() => service.publish(sampleCoreDraft({ attributes: broken }), ADMIN_A))
    expect(error.issues?.some((issue) => issue.code === 'CARDINALITY_INVALID')).toBe(true)
  })

  it('rejects a cardinality that contradicts an identity key', async () => {
    const { service } = buildService()
    const broken = replaceAttribute('device_native_id', {
      ...core().attributes[0]!,
      cardinality: { min: 0, max: 1 },
    })
    const error = await captureError(() => service.publish(sampleCoreDraft({ attributes: broken }), ADMIN_A))
    expect(error.issues?.some((issue) => issue.code === 'CARDINALITY_KIND_CONFLICT')).toBe(true)
  })

  it('requires a unit for a quantity attribute', async () => {
    const { service } = buildService()
    const quantityWithoutUnit: AttributeDefinition = {
      kind: 'attribute',
      id: 'rated_power',
      namespace: NAMESPACE,
      objectId: 'device',
      valueType: 'quantity',
      cardinality: { min: 0, max: 1 },
      standardProvenance: provenance(),
    }
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ attributes: replaceAttribute('rated_power', quantityWithoutUnit) }), ADMIN_A),
    )
    expect(error.issues?.some((issue) => issue.code === 'UNIT_REQUIRED')).toBe(true)
  })

  it('forbids a unit on a non-quantity attribute', async () => {
    const { service } = buildService()
    const withUnit = replaceAttribute('device_name', {
      ...core().attributes[1]!,
      unit: { unitCode: 'kW', dimension: 'power' },
    })
    const error = await captureError(() => service.publish(sampleCoreDraft({ attributes: withUnit }), ADMIN_A))
    expect(error.issues?.some((issue) => issue.code === 'UNIT_FORBIDDEN')).toBe(true)
  })

  it('requires enum values for an enum attribute', async () => {
    const { service } = buildService()
    const enumWithoutValues: AttributeDefinition = {
      kind: 'attribute',
      id: 'device_kind',
      namespace: NAMESPACE,
      objectId: 'device',
      valueType: 'enum',
      cardinality: { min: 1, max: 1 },
      standardProvenance: provenance(),
    }
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ attributes: replaceAttribute('device_kind', enumWithoutValues) }), ADMIN_A),
    )
    expect(error.issues?.some((issue) => issue.code === 'ENUM_REQUIRED')).toBe(true)
  })

  it('requires a target object for a reference attribute', async () => {
    const { service } = buildService()
    const referenceWithoutTarget: AttributeDefinition = {
      kind: 'attribute',
      id: 'meter_device',
      namespace: NAMESPACE,
      objectId: 'meter',
      valueType: 'reference',
      cardinality: { min: 0, max: 1 },
      standardProvenance: provenance(),
    }
    const error = await captureError(() =>
      service.publish(
        sampleCoreDraft({ attributes: replaceAttribute('meter_device', referenceWithoutTarget) }),
        ADMIN_A,
      ),
    )
    expect(error.issues?.some((issue) => issue.code === 'REFERENCE_REQUIRED')).toBe(true)
  })

  it('rejects a missing or invalid standard provenance', async () => {
    const { service } = buildService()
    const missing = await captureError(() =>
      service.publish(sampleCoreDraft({ standardProvenance: [] }), ADMIN_A),
    )
    expect(missing.issues?.some((issue) => issue.code === 'STANDARD_PROVENANCE_MISSING')).toBe(true)

    const invalid = await captureError(() =>
      service.publish(
        sampleCoreDraft({
          standardProvenance: [
            {
              standardRef: { id: 'iec-61851-1', version: '1.0.0', digest: 'not-a-digest' },
              provenanceKind: 'international_standard',
            },
          ],
        }),
        ADMIN_A,
      ),
    )
    expect(invalid.issues?.some((issue) => issue.code === 'STANDARD_PROVENANCE_INVALID')).toBe(true)
  })

  it('rejects duplicate definitions and a mismatched namespace', async () => {
    const { service } = buildService()
    const duplicate = await captureError(() =>
      service.publish(sampleCoreDraft({ objects: [...core().objects, { ...core().objects[0]! }] }), ADMIN_A),
    )
    expect(duplicate.issues?.some((issue) => issue.code === 'DUPLICATE_DEFINITION')).toBe(true)

    const mismatch = await captureError(() =>
      service.publish(
        sampleCoreDraft({ objects: replaceObject('device', { ...core().objects[0]!, namespace: 'other-pack' }) }),
        ADMIN_A,
      ),
    )
    expect(mismatch.issues?.some((issue) => issue.code === 'NAMESPACE_MISMATCH')).toBe(true)
  })

  it('rejects a definition version carrying a connection address', async () => {
    const { service } = buildService()
    const smuggledDevice: ObjectDefinition = {
      ...core().objects[0]!,
      displayName: 'https://internal.example/device',
    }
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ objects: replaceObject('device', smuggledDevice) }), ADMIN_A),
    )
    expect(error.issues?.some((issue) => issue.code === 'PURITY_VIOLATION')).toBe(true)
  })

  it('flags forbidden fields, URLs and credentials in a smuggled declaration', () => {
    const issues = scanDefinitionPurity({
      objects: [
        { id: 'device', connectionString: 'postgresql://user:pw@host:5432/db', tableName: 'devices' },
      ],
      attributes: [{ id: 'x', sdk: '@ontology/adapter-data-postgres' }],
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.code === 'PURITY_VIOLATION')).toBe(true)
    expect(issues.some((issue) => issue.reason.includes('connectionString'))).toBe(true)
  })
})

describe('semantic definition core/extension isolation (unit)', () => {
  it('publishes a customer extension on top of a core version without shadowing it', async () => {
    const { service } = buildService()
    const published = await service.publish(core(), ADMIN_A)
    const extension = await service.publish(sampleExtensionDraft(published.ref), ADMIN_A)

    expect(extension.layer).toBe('customer_extension')
    expect(extension.baseRef).toEqual(published.ref)
    expect(extension.attributes.map((attribute) => attribute.id)).toEqual(['acme_warranty_until'])

    const coreStill = await service.getVersion(
      { scopeRef: SCOPE_A, namespace: NAMESPACE, definitionId: CORE_DEFINITION_ID, version: '1.0.0' },
      ADMIN_A,
    )
    expect(coreStill.attributes.map((attribute) => attribute.id)).not.toContain('acme_warranty_until')
  })

  it('refuses an extension that shadows a core definition', async () => {
    const { service } = buildService()
    const published = await service.publish(core(), ADMIN_A)
    const shadowing: AttributeDefinition = {
      kind: 'attribute',
      id: 'rated_power',
      namespace: NAMESPACE,
      objectId: 'device',
      valueType: 'quantity',
      cardinality: { min: 0, max: 1 },
      unit: { unitCode: 'W', dimension: 'power' },
      standardProvenance: provenance(),
    }
    const error = await captureError(() =>
      service.publish(
        sampleCoreDraft({
          definitionId: 'acme.shadow',
          layer: 'customer_extension',
          baseRef: published.ref,
          objects: [],
          attributes: [shadowing],
          relations: [],
          identityScopes: [],
          ruleConstraints: [],
        }),
        ADMIN_A,
      ),
    )
    expect(error.issues?.some((issue) => issue.code === 'CORE_SHADOWING_FORBIDDEN')).toBe(true)
  })

  it('refuses to build a definition on a non-core base', async () => {
    const { service } = buildService()
    const published = await service.publish(core(), ADMIN_A)
    const extension = await service.publish(sampleExtensionDraft(published.ref), ADMIN_A)
    const error = await captureError(() =>
      service.publish(
        sampleCoreDraft({
          definitionId: 'acme.second-extension',
          layer: 'customer_extension',
          baseRef: extension.ref,
          objects: [],
          attributes: [],
          relations: [],
          identityScopes: [],
          ruleConstraints: [],
        }),
        ADMIN_A,
      ),
    )
    expect(error.issues?.some((issue) => issue.code === 'LAYER_BASE_FORBIDDEN')).toBe(true)
  })

  it('refuses an extension that does not declare a base version', async () => {
    const { service } = buildService()
    const draft = sampleCoreDraft({
      definitionId: 'acme.no-base',
      layer: 'customer_extension',
      objects: [],
      attributes: [],
      relations: [],
      identityScopes: [],
      ruleConstraints: [],
    })
    const error = await captureError(() => service.publish(draft, ADMIN_A))
    expect(error.issues?.some((issue) => issue.code === 'LAYER_BASE_REQUIRED')).toBe(true)
  })

  it('reports a missing base version before publication', async () => {
    const { service } = buildService()
    const missingBase = { id: CORE_DEFINITION_ID, version: '9.9.9', digest: `sha256:${'c'.repeat(64)}` }
    const error = await captureError(() => service.publish(sampleExtensionDraft(missingBase), ADMIN_A))
    expect(error.code).toBe('BASE_VERSION_NOT_FOUND')
  })
})

describe('semantic definition version binding (unit)', () => {
  it('keeps data bound to the definition version it was created under', async () => {
    const { service } = buildService()
    const v1 = await service.publish(core(), ADMIN_A)

    const binding = await service.bindData(
      { scopeRef: SCOPE_A, dataRef: dataRef(), namespace: NAMESPACE, definitionRef: v1.ref },
      ADMIN_A,
    )
    expect(binding.definitionRef).toEqual(v1.ref)

    const power = core().attributes.find((attribute) => attribute.id === 'rated_power')
    if (power === undefined) throw new Error('fixture is missing rated_power')
    const v2 = await service.publish(
      sampleCoreDraft({
        version: '2.0.0',
        baseRef: v1.ref,
        attributes: replaceAttribute('rated_power', { ...power, unit: { unitCode: 'W', dimension: 'power' } }),
      }),
      ADMIN_A,
    )
    expect(v2.ref.digest).not.toBe(v1.ref.digest)

    const resolved = await service.resolveDataDefinition({ scopeRef: SCOPE_A, dataRefId: DATA_REF_ID }, ADMIN_A)
    expect(resolved.version.ref).toEqual(v1.ref)
    expect(
      resolved.version.attributes.find((attribute) => attribute.id === 'rated_power')?.unit?.unitCode,
    ).toBe('kW')

    const latest = await service.getVersion(
      { scopeRef: SCOPE_A, namespace: NAMESPACE, definitionId: CORE_DEFINITION_ID, version: '2.0.0' },
      ADMIN_A,
    )
    expect(latest.attributes.find((attribute) => attribute.id === 'rated_power')?.unit?.unitCode).toBe('W')

    const rebind = await captureError(() =>
      service.bindData(
        { scopeRef: SCOPE_A, dataRef: dataRef(), namespace: NAMESPACE, definitionRef: v2.ref },
        ADMIN_A,
      ),
    )
    expect(rebind.code).toBe('BINDING_CONFLICT')
  })

  it('refuses to bind to an unpublished or mismatched definition version', async () => {
    const { service } = buildService()
    const v1 = await service.publish(core(), ADMIN_A)

    const wrongDigest = await captureError(() =>
      service.bindData(
        {
          scopeRef: SCOPE_A,
          dataRef: dataRef(DIGEST_B),
          namespace: NAMESPACE,
          definitionRef: { ...v1.ref, digest: DIGEST_B },
        },
        ADMIN_A,
      ),
    )
    expect(wrongDigest.code).toBe('DEFINITION_NOT_FOUND')

    const unbound = await captureError(() =>
      service.resolveDataDefinition({ scopeRef: SCOPE_A, dataRefId: DATA_REF_ID }, ADMIN_A),
    )
    expect(unbound.code).toBe('BINDING_NOT_FOUND')
  })
})

describe('semantic engine package purity (unit)', () => {
  it('declares no SDK/driver dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../packages/semantic-engine/package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const dependencies = Object.keys(packageJson.dependencies ?? {})
    expect(dependencies.sort()).toEqual(['@ontology/contracts', '@ontology/core'])
  })
})
