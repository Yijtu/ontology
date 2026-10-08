import { describe, expect, it, vi } from 'vitest'
import type { PackAsset, ScopeRef, SemanticDefinitionVersion, VersionRef } from '@ontology/contracts'
import {
  createDynamicDefinitionTerminologySource,
  DynamicDefinitionTerminologySource,
  InMemoryIndustryPackCatalogue,
  StaticDefinitionTerminologySource,
} from '@ontology/application'
import { sampleCoreDraft } from './semantic-definition-fixtures'
import { toolContext } from './component-registry-fixtures'

const SCOPE: ScopeRef = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const CTX = toolContext(SCOPE.tenantId, SCOPE.spaceId)
const DIGEST = `sha256:${'a'.repeat(64)}`
const REF: VersionRef = { id: 'home-energy.pack-a', version: '1.0.0', digest: DIGEST }
const DEFINITION: SemanticDefinitionVersion = {
  ...sampleCoreDraft(),
  ref: { id: 'home-energy.core', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
  publishedAt: '2026-10-01T00:00:00Z',
}

function pack(ref = REF): PackAsset {
  return {
    ref,
    manifest: {
      namespace: DEFINITION.namespace,
      maturity: 'stable',
      definitionsRef: DEFINITION.ref,
      standardProvenance: [...DEFINITION.standardProvenance],
      identityPolicyRef: REF,
      rulePolicyRef: REF,
      queryTemplatesRef: REF,
      requiredCapabilities: [],
      testSuiteRef: REF,
    },
    testSuite: { ref: REF, cases: [] },
  }
}

function fixture(definition: SemanticDefinitionVersion | undefined = DEFINITION, asset = pack()) {
  const catalogue = new InMemoryIndustryPackCatalogue()
  catalogue.registerPack(asset)
  const findVersion = vi.fn<() => Promise<SemanticDefinitionVersion | undefined>>(async () => definition)
  return { source: createDynamicDefinitionTerminologySource({ catalogue, definitions: { findVersion } }), catalogue, findVersion }
}

describe('exact mounted definition terminology', () => {
  it('permits bootstrap only without a base pin', async () => {
    const h = fixture()
    expect(await h.source.getTerminology(SCOPE, undefined, CTX)).toBeUndefined()
    expect(h.findVersion).not.toHaveBeenCalled()
    await expect(h.source.getTerminology(SCOPE, { ...REF, id: 'missing' }, CTX)).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' })
  })

  it('preserves all static declarations, identity, units and versioned provenance without merging names', async () => {
    const definition = { ...DEFINITION, objects: DEFINITION.objects.map((object) => ({ ...object, displayName: 'Asset' })) }
    const h = fixture(definition)
    const terms = await h.source.getTerminology(SCOPE, REF, CTX)
    expect(terms?.objectLogicalIds).toEqual(['device', 'meter'])
    expect(terms?.displayNames).toEqual({ device: 'Asset', meter: 'Asset' })
    expect(terms?.definition).toMatchObject({ ref: DEFINITION.ref, publishedAt: DEFINITION.publishedAt,
      standardProvenance: DEFINITION.standardProvenance, objects: definition.objects, attributes: definition.attributes,
      relations: definition.relations, identityScopes: definition.identityScopes, ruleConstraints: definition.ruleConstraints })
    expect(terms?.attributes.find((attribute) => attribute.logicalId === 'rated_power')).toEqual({
      logicalId: 'rated_power', objectLogicalId: 'device', valueType: 'quantity', unitCode: 'kW', dimension: 'power',
    })
    expect(h.findVersion).toHaveBeenCalledExactlyOnceWith(DEFINITION.namespace, DEFINITION.ref.id, DEFINITION.ref.version, SCOPE, CTX)
  })

  it('uses the same exact dynamic reader without scanning namespace peers or selecting a newer version', async () => {
    const h = fixture()
    const findByRef = vi.fn(async () => undefined)
    // 101 unrelated registered versions do not affect the pinned lookup.
    for (let index = 1; index <= 101; index += 1) h.catalogue.registerPack(pack({ ...REF, version: `1.0.${String(index)}` }))
    const source = new DynamicDefinitionTerminologySource({ catalogue: h.catalogue, definitions: { findVersion: h.findVersion }, publishedPacks: { findByRef } })
    expect((await source.getTerminology(SCOPE, REF, CTX))?.packRef).toEqual(REF)
    expect(findByRef).toHaveBeenCalledExactlyOnceWith(SCOPE, REF, CTX)
    expect(h.findVersion).toHaveBeenCalledExactlyOnceWith(DEFINITION.namespace, DEFINITION.ref.id, '1.0.0', SCOPE, CTX)
  })

  it('fails a retired pack and a changed pack digest before reading definitions', async () => {
    const retired = fixture(DEFINITION, { ...pack(), manifest: { ...pack().manifest, maturity: 'deprecated' } })
    await expect(retired.source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
    expect(retired.findVersion).not.toHaveBeenCalled()
    const h = fixture()
    await expect(h.source.getTerminology(SCOPE, { ...REF, digest: `sha256:${'c'.repeat(64)}` }, CTX)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(h.findVersion).not.toHaveBeenCalled()
  })

  it.each([
    { ...DEFINITION, ref: { ...DEFINITION.ref, digest: DIGEST } },
    { ...DEFINITION, ref: { ...DEFINITION.ref, id: 'other-definition' } },
    { ...DEFINITION, ref: { ...DEFINITION.ref, version: '2.0.0' } },
  ])('fails unavailable or incorrect definition pins explicitly', async (definition) => {
    const h = fixture(definition)
    await expect(h.source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' })
  })

  it('fails a missing definition without returning empty terminology', async () => {
    const h = fixture()
    h.findVersion.mockResolvedValueOnce(undefined)
    await expect(h.source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' })
  })

  it('rejects a scope mismatch before reading and rejects a reader returning another tenant', async () => {
    const h = fixture()
    await expect(h.source.getTerminology({ ...SCOPE, tenantId: '22222222-2222-4222-8222-222222222222' }, REF, CTX)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    expect(h.findVersion).not.toHaveBeenCalled()
    const wrongScope = fixture({ ...DEFINITION, scopeRef: { ...SCOPE, spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } })
    await expect(wrongScope.source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const wrongNamespace = fixture({ ...DEFINITION, namespace: 'other-industry' })
    await expect(wrongNamespace.source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('rejects malformed pins at the application boundary before calling a reader', async () => {
    const h = fixture()
    await expect(h.source.getTerminology(SCOPE, { ...REF, digest: 'not-a-digest' }, CTX)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(h.findVersion).not.toHaveBeenCalled()
  })

  it('rechecks authorisation and retirement on every read instead of caching visibility', async () => {
    const findPack = vi.fn().mockResolvedValueOnce(pack()).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      ...pack(), manifest: { ...pack().manifest, maturity: 'deprecated' },
    })
    const source = createDynamicDefinitionTerminologySource({ catalogue: { findPack, listEntries: async () => [] }, definitions: { findVersion: async () => DEFINITION } })
    expect((await source.getTerminology(SCOPE, REF, CTX))?.objectLogicalIds).toContain('device')
    await expect(source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' })
    await expect(source.getTerminology(SCOPE, REF, CTX)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  })

  it('keys fixed terms by the full ref and never uses a bootstrap fallback for a missing pin', async () => {
    const empty = { objectLogicalIds: [], attributeLogicalIds: [], relationLogicalIds: [], attributes: [], displayNames: {} }
    const source = new StaticDefinitionTerminologySource([{ definitionRef: REF, terminology: empty }], empty)
    expect(await source.getTerminology(SCOPE, REF, CTX)).toEqual(empty)
    for (const ref of [{ ...REF, id: 'other' }, { ...REF, version: '2.0.0' }, { ...REF, digest: `sha256:${'c'.repeat(64)}` }]) {
      await expect(source.getTerminology(SCOPE, ref, CTX)).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' })
    }
    expect(await source.getTerminology(SCOPE, undefined, CTX)).toEqual(empty)
  })
})
