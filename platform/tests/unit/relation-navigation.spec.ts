import { describe, expect, it } from 'vitest'
import type {
  IdentityAssertionRecord,
  IdentityEntityRecord,
  IdentityPublishedBinding,
  IdentityPublishedBindingSnapshot,
  PublishedStatement,
  PublishedStatementFilter,
  ScopeRef,
  VersionRef,
} from '@ontology/contracts'
import { RelationNavigationError } from '@ontology/contracts'
import { PublishedRelationNavigator } from '@ontology/semantic-engine'
import { SPACE_A, TENANT_A, toolContext } from './component-registry-fixtures'

/**
 * Independent acceptance samples for bounded published-relation navigation (issue V03-027 /
 * #195, A.US-008.AC-02, A.FR-14). The expectations are derived from SPEC v0.3a EX-4.3: ≤3 hops,
 * grounded endpoints only, explicit completeness and a refusal of unknown/cyclic expansion.
 */

const DEFINITION: VersionRef = { id: 'definition.core', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` }
const OTHER_DEFINITION: VersionRef = { id: 'definition.other', version: '2.0.0', digest: `sha256:${'e'.repeat(64)}` }
const CTX = toolContext(TENANT_A, SPACE_A)
const NOW = () => Date.parse('2026-09-21T00:00:00Z')

interface EdgeSpec {
  readonly statementId: string
  readonly version?: string
  readonly publicationId?: string
  readonly relationId: string
  readonly fromCandidate: string
  readonly toCandidate: string
  readonly kind?: 'relation' | 'entity'
  readonly fromObjectId?: string
  readonly toObjectId?: string
  readonly validFrom?: string
  readonly validTo?: string
}

interface FixtureOptions {
  readonly edges: readonly EdgeSpec[]
  readonly candidateEntity: ReadonlyMap<string, string>
  readonly publicationSchema?: ReadonlyMap<string, VersionRef>
  readonly entities?: ReadonlyMap<string, { readonly objectId: string; readonly revision: string; readonly state?: 'confirmed' | 'pending' | 'retired' }>
  readonly cannotLink?: ReadonlyMap<string, readonly string[]>
}

function statementOf(edge: EdgeSpec): PublishedStatement {
  return {
    statementId: edge.statementId,
    propositionKey: edge.statementId,
    kind: edge.kind ?? 'relation',
    relationId: edge.relationId,
    predicate: edge.relationId,
    value: {
      from: { objectId: edge.fromObjectId ?? 'device', candidateId: edge.fromCandidate },
      to: { objectId: edge.toObjectId ?? 'device', candidateId: edge.toCandidate },
    },
    ...(edge.validFrom === undefined ? {} : { validFrom: edge.validFrom }),
    ...(edge.validTo === undefined ? {} : { validTo: edge.validTo }),
    recordedAt: '2026-09-20T00:00:00Z',
    sourceCandidateId: edge.fromCandidate,
    sourceRefs: [{ id: edge.statementId, version: '1.0.0', digest: `sha256:${'f'.repeat(64)}`, kind: 'chunk' }],
    publicationId: edge.publicationId ?? 'publication-1',
    version: edge.version ?? '1',
    status: 'active',
  }
}

function navigator(options: FixtureOptions): PublishedRelationNavigator {
  const statements = options.edges
    .map(statementOf)
    .sort((left, right) => left.statementId.localeCompare(right.statementId))
  const entities = options.entities ?? new Map()
  const publicationSchema = options.publicationSchema ?? new Map([['publication-1', DEFINITION]])

  const publications = {
    async listStatements(_scope: ScopeRef, filter: PublishedStatementFilter): Promise<PublishedStatement[]> {
      const after = filter.afterStatementId
      return statements
        .filter((statement) => after === undefined || statement.statementId > after)
        .filter((statement) => filter.status === undefined || statement.status === filter.status)
        .slice(0, filter.limit ?? 100)
    },
    async getPublication(_scope: ScopeRef, publicationId: string) {
      const schemaRef = publicationSchema.get(publicationId)
      return schemaRef === undefined
        ? undefined
        : {
            publicationId,
            versionRef: schemaRef,
            revision: '1',
            schemaRef,
            approvedCandidateRefs: [],
            statements: [],
            ruleVersions: [],
            outboxId: publicationId,
            publishedAt: '2026-09-20T00:00:00Z',
            actor: 'test',
          }
    },
    async getStatement(_scope: ScopeRef, statementId: string) {
      return statements.find((statement) => statement.statementId === statementId)
    },
    async latestPublicationRevision() {
      return '1'
    },
  }

  const identity = {
    async getEntity(_scope: ScopeRef, entityId: string): Promise<IdentityEntityRecord | undefined> {
      const entity = entities.get(entityId)
      if (entity === undefined) return undefined
      return {
        entityId,
        objectId: entity.objectId,
        identityScopeId: 'identity.device',
        scopeDimensions: {},
        state: entity.state ?? 'confirmed',
        revision: entity.revision,
        recordedAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:00:00Z',
      }
    },
    async readPublishedBindings(_scope: ScopeRef, candidateIds: readonly string[]): Promise<IdentityPublishedBindingSnapshot> {
      const bindings: IdentityPublishedBinding[] = candidateIds.map((candidateId) => {
        const entityId = options.candidateEntity.get(candidateId)
        const openAssertions: IdentityAssertionRecord[] =
          entityId === undefined
            ? []
            : [
                {
                  assertionId: `assertion-${candidateId}`,
                  candidateId,
                  entityId,
                  objectId: 'device',
                  identityScopeId: 'identity.device',
                  decisionId: `decision-${candidateId}`,
                  validFrom: '2026-09-20T00:00:00Z',
                  recordedAt: '2026-09-20T00:00:00Z',
                },
              ]
        return {
          candidateId,
          openAssertions,
          cannotLinkEntityIds: options.cannotLink?.get(candidateId) ?? [],
        }
      })
      return { readRevision: '1', bindings, complete: true }
    },
  }

  return new PublishedRelationNavigator({
    publications,
    identity,
    definitionRef: DEFINITION,
    allowedRelationIds: ['connects', 'feeds'],
    relationTargets: new Map([
      ['connects', { fromObjectId: 'device', toObjectId: 'device' }],
      ['feeds', { fromObjectId: 'device', toObjectId: 'device' }],
    ]),
    now: NOW,
  })
}

const ENTITIES = new Map([
  ['e1', { objectId: 'device', revision: '1' }],
  ['e2', { objectId: 'device', revision: '1' }],
  ['e3', { objectId: 'device', revision: '1' }],
])

describe('bounded published relation navigation (V03-027)', () => {
  it('navigates a one-hop confirmed relation and reports entity, statement version, source and completeness', async () => {
    const navigatorUnderTest = navigator({
      edges: [{ statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2' }],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
      ]),
      entities: ENTITIES,
    })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.completeness).toBe('complete')
    expect(result.gaps).toEqual([])
    expect(result.paths).toHaveLength(1)
    expect(result.paths[0]?.endEntityId).toBe('e2')
    expect(result.paths[0]?.hops[0]?.statementVersion).toBe('1')
    expect(result.paths[0]?.hops[0]?.relationId).toBe('connects')
    expect(result.paths[0]?.hops[0]?.sourceRefs).toHaveLength(1)
    expect(result.visitedEntityIds).toEqual(['e1', 'e2'])
    expect(result.relationVersionIds).toEqual(['s1@1'])
  })

  it('follows up to three hops and refuses a request beyond the bound', async () => {
    const navigatorUnderTest = navigator({
      edges: [
        { statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2' },
        { statementId: 's2', relationId: 'connects', fromCandidate: 'c2', toCandidate: 'c3' },
      ],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
        ['c3', 'e3'],
      ]),
      entities: ENTITIES,
    })
    const threeHop = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects', 'connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(threeHop.paths).toHaveLength(1)
    expect(threeHop.paths[0]?.hops).toHaveLength(2)
    expect(threeHop.paths[0]?.endEntityId).toBe('e3')

    await expect(
      navigatorUnderTest.navigate(
        { startEntityId: 'e1', relationIds: ['connects', 'connects', 'connects', 'connects'], validAt: '2026-09-21T00:00:00Z' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(RelationNavigationError)
  })

  it('reports an unknown start endpoint as incomplete instead of fabricating a path', async () => {
    const navigatorUnderTest = navigator({ edges: [], candidateEntity: new Map(), entities: ENTITIES })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'missing', relationIds: ['connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.completeness).toBe('unknown')
    expect(result.gaps).toContain('START_ENTITY_NOT_FOUND')
    expect(result.paths).toEqual([])
  })

  it('refuses a relation statement published against another definition', async () => {
    const navigatorUnderTest = navigator({
      edges: [{ statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2', publicationId: 'publication-2' }],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
      ]),
      entities: ENTITIES,
      publicationSchema: new Map([['publication-2', OTHER_DEFINITION]]),
    })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.gaps).toContain('RELATION_DEFINITION_MISMATCH')
    expect(result.paths).toEqual([])
    expect(result.completeness).toBe('unknown')
  })

  it('refuses a cyclic expansion back to an entity already on the path', async () => {
    const navigatorUnderTest = navigator({
      edges: [
        { statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2' },
        { statementId: 's2', relationId: 'connects', fromCandidate: 'c2', toCandidate: 'c1' },
      ],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
      ]),
      entities: ENTITIES,
    })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects', 'connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.gaps).toContain('RELATION_CYCLE_REFUSED')
    expect(result.paths).toEqual([])
  })

  it('never walks a non-relation (field/JOIN-shaped) statement as an entity edge', async () => {
    const navigatorUnderTest = navigator({
      edges: [
        { statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2', kind: 'entity' },
      ],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
      ]),
      entities: ENTITIES,
    })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.paths).toEqual([])
    expect(result.gaps).toContain('NO_CONFIRMED_PATH')
  })

  it('refuses an edge whose endpoints are not the schema-declared target objects', async () => {
    const navigatorUnderTest = navigator({
      edges: [{ statementId: 's1', relationId: 'connects', fromCandidate: 'c1', toCandidate: 'c2', toObjectId: 'sensor' }],
      candidateEntity: new Map([
        ['c1', 'e1'],
        ['c2', 'e2'],
      ]),
      entities: ENTITIES,
    })
    const result = await navigatorUnderTest.navigate(
      { startEntityId: 'e1', relationIds: ['connects'], validAt: '2026-09-21T00:00:00Z' },
      CTX,
    )
    expect(result.gaps).toContain('RELATION_TARGET_MISMATCH')
    expect(result.paths).toEqual([])
  })

  it('refuses a relation path not enabled by the pinned definition/profile', async () => {
    const navigatorUnderTest = navigator({ edges: [], candidateEntity: new Map(), entities: ENTITIES })
    await expect(
      navigatorUnderTest.navigate(
        { startEntityId: 'e1', relationIds: ['not_declared'], validAt: '2026-09-21T00:00:00Z' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(RelationNavigationError)
  })
})
