import { createHash } from 'node:crypto'
import type {
  CompetencySourceLocation, RuleConclusionBinding, RuleExceptionNode, RuleExpressionNode,
  SemanticDefinitionVersionDraft, VersionRef,
} from '@ontology/contracts'
import { definitionVersionDigest } from '@ontology/semantic-engine'

/** These helpers hash authored declarations; they never query, evaluate rules or compute gold. */
export function canonicalCompetencyJson(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item
  return JSON.stringify(ordered(value))
}
export function competencyDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCompetencyJson(value), 'utf8').digest('hex')}`
}
export function textDigest(text: string): string {
  return byteDigest(new TextEncoder().encode(text))
}
export function byteDigest(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

export interface CompetencyFixtureRule {
  readonly ref: VersionRef
  readonly declaration: {
    readonly ruleId: string
    readonly objectId: string
    readonly condition: RuleExpressionNode
    readonly exceptions: readonly RuleExceptionNode[]
    readonly ruleDependencies: readonly string[]
    readonly conclusion: RuleConclusionBinding
  }
  readonly source: CompetencySourceLocation
}
export interface CompetencyFixtureDefinition {
  readonly ref: VersionRef
  readonly draft: SemanticDefinitionVersionDraft
}

export const COMPETENCY_SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
export const TRANSPORT_PROJECT = '33333333-3333-4333-8333-333333333333'
export const INDUSTRIAL_PROJECT = '44444444-4444-4444-8444-444444444444'
export const FOREIGN_PROJECT = '55555555-5555-4555-8555-555555555555'

export const TRANSPORT_TEXT = [
  'Synthetic transport example; not an industry standard.',
  'F-01 facility_code=F-01; length=12.5 m; condition=bad; closed=false; located_in=D-01.',
  'F-02 facility_code=F-02; length=5.0 m; condition=good; closed=false.',
  'D-01 district_code=D-01; watch=true.',
  'Alternative survey of F-01 reports condition=good.',
  'For the exception case F-01 closed=true.',
  'Wrong-unit source for F-01 reports length=12.5 h.',
  'Inspection rule: condition=bad triggers needs_inspection=true, unless closed=true.',
  'District rule: a resolved located_in edge AND target watch=true triggers needs_inspection=true.',
  'A withdrawal removes only its named support; remaining support still applies.',
].join('\n') + '\n'
export const INDUSTRIAL_TEXT = [
  'Synthetic industrial maintenance example; not an industry standard.',
  'A-01 asset_code=A-01; hours=120 h; exempt=false; alarm=true; in_workshop=W-01.',
  'A-02 asset_code=A-02; hours=30 h; exempt=false; alarm=false.',
  'W-01 shop_code=W-01; staffed=false.',
  'Service rule: hours>=100 h triggers stage_one=true, unless exempt=true.',
  'Second layer: stage_one=true from the service rule triggers stage_two=true.',
  'Third layer: stage_two=true from the second layer triggers ready=true.',
  'Alarm rule: alarm=true is an independent support for stage_one=true.',
  'Either hours>=100 h or alarm=true supports stage_one=true.',
  'Boundary sample A-03 asset_code=A-03; hours=100 h; exempt=false.',
  'Version two adds inspection_due; the version-two observation says A-01 inspection_due=true.',
].join('\n') + '\n'

export function competencyFixtureDocument(id: string, text: string) {
  const ref = { id: `cq.${id}.source`, version: '1.0.0', digest: textDigest(text) }
  return { ref, text, location(quote: string): CompetencySourceLocation {
    const bytes = Buffer.from(text, 'utf8'), quoted = Buffer.from(quote, 'utf8')
    const startOffset = bytes.indexOf(quoted)
    if (startOffset < 0 || quoted.length === 0) throw new Error(`unknown authored source quote: ${quote}`)
    return { sourceRef: ref, offsetUnit: 'utf8_byte', startOffset, endOffset: startOffset + quoted.length, quoteDigest: byteDigest(quoted) }
  } }
}
export const TRANSPORT_DOCUMENT = competencyFixtureDocument('transport', TRANSPORT_TEXT)
export const INDUSTRIAL_DOCUMENT = competencyFixtureDocument('industrial', INDUSTRIAL_TEXT)

function definition(industry: string, version: string, objects: readonly string[], fields: readonly [string, string, 'string' | 'boolean' | 'quantity' | 'enum', string?][], relation: readonly [string, string, string], sourceRef: VersionRef): CompetencyFixtureDefinition {
  const namespace = `cq-${industry}-synthetic`
  const provenance = [{ standardRef: sourceRef, provenanceKind: 'synthetic_assumption' as const }]
  const draft: SemanticDefinitionVersionDraft = {
    scopeRef: COMPETENCY_SCOPE, namespace, definitionId: `cq.${industry}.definition`, version, layer: 'industry_core', standardProvenance: provenance,
    objects: objects.map((id) => ({ kind: 'object', id, namespace, displayName: id, identityScopeId: `${id}.identity`, standardProvenance: provenance })),
    attributes: fields.map(([id, objectId, valueType, unit]) => ({ kind: 'attribute', id, namespace, objectId, valueType,
      cardinality: { min: id.endsWith('_code') ? 1 : 0, max: 1 }, ...(id.endsWith('_code') ? { identityKey: true } : {}),
      ...(unit === undefined ? {} : { unit: { unitCode: unit, dimension: unit === 'm' ? 'length' : 'time' } }),
      ...(valueType === 'enum' ? { enumValues: ['good', 'bad'] } : {}), standardProvenance: provenance })),
    relations: [{ kind: 'relation', id: relation[0], namespace, fromObjectId: relation[1], toObjectId: relation[2], cardinality: { min: 0, max: 1 }, standardProvenance: provenance }],
    identityScopes: objects.map((objectId) => ({ kind: 'identity_scope', id: `${objectId}.identity`, namespace, objectId,
      scopeDimensions: ['project'], identityAttributeIds: [objectId === 'facility' ? 'facility_code' : objectId === 'district' ? 'district_code' : objectId === 'asset' ? 'asset_code' : 'shop_code'], standardProvenance: provenance })),
    ruleConstraints: [],
  }
  return { draft, ref: { id: draft.definitionId, version, digest: definitionVersionDigest(draft) } }
}
export const TRANSPORT_DEFINITION = definition('transport', '1.0.0', ['facility', 'district'], [
  ['facility_code', 'facility', 'string'], ['length', 'facility', 'quantity', 'm'], ['condition', 'facility', 'enum'],
  ['closed', 'facility', 'boolean'], ['needs_inspection', 'facility', 'boolean'], ['district_code', 'district', 'string'], ['watch', 'district', 'boolean'],
], ['located_in', 'facility', 'district'], TRANSPORT_DOCUMENT.ref)
const industrialFields: readonly [string, string, 'string' | 'boolean' | 'quantity', string?][] = [
  ['asset_code', 'asset', 'string'], ['hours', 'asset', 'quantity', 'h'], ['exempt', 'asset', 'boolean'], ['alarm', 'asset', 'boolean'],
  ['stage_one', 'asset', 'boolean'], ['stage_two', 'asset', 'boolean'], ['ready', 'asset', 'boolean'], ['shop_code', 'workshop', 'string'], ['staffed', 'workshop', 'boolean'],
]
export const INDUSTRIAL_DEFINITION = definition('industrial', '1.0.0', ['asset', 'workshop'], industrialFields, ['in_workshop', 'asset', 'workshop'], INDUSTRIAL_DOCUMENT.ref)
export const INDUSTRIAL_DEFINITION_V2 = definition('industrial', '2.0.0', ['asset', 'workshop'], [...industrialFields, ['inspection_due', 'asset', 'boolean']], ['in_workshop', 'asset', 'workshop'], INDUSTRIAL_DOCUMENT.ref)

const compare = (attributeId: string, value: string | boolean): RuleExpressionNode => ({ op: 'compare', attributeId, operator: 'eq', value, spans: [] })
function rule(industry: string, declaration: CompetencyFixtureRule['declaration'], quote: string): CompetencyFixtureRule {
  const source = (industry === 'transport' ? TRANSPORT_DOCUMENT : INDUSTRIAL_DOCUMENT).location(quote)
  return { ref: { id: `cq.${industry}.rule.${declaration.ruleId}`, version: '1.0.0', digest: competencyDigest({ declaration, source }) }, declaration, source }
}
export const TRANSPORT_RULES = [
  rule('transport', { ruleId: 'inspection', objectId: 'facility', condition: compare('condition', 'bad'),
    exceptions: [{ exceptionId: 'closed', condition: compare('closed', true), spans: [] }], ruleDependencies: [], conclusion: { predicate: 'needs_inspection', value: true } },
  'Inspection rule: condition=bad triggers needs_inspection=true, unless closed=true.'),
  rule('transport', { ruleId: 'district-watch', objectId: 'facility', condition: { op: 'relation', relationId: 'located_in', targetCondition: compare('watch', true), spans: [] },
    exceptions: [], ruleDependencies: [], conclusion: { predicate: 'needs_inspection', value: true } },
  'District rule: a resolved located_in edge AND target watch=true triggers needs_inspection=true.'),
] as const
export const INDUSTRIAL_RULES = [
  rule('industrial', { ruleId: 'service', objectId: 'asset', condition: { op: 'range', attributeId: 'hours', min: 100, unitCode: 'h', spans: [] },
    exceptions: [{ exceptionId: 'exempt', condition: compare('exempt', true), spans: [] }], ruleDependencies: [], conclusion: { predicate: 'stage_one', value: true } },
  'Service rule: hours>=100 h triggers stage_one=true, unless exempt=true.'),
  rule('industrial', { ruleId: 'layer-two', objectId: 'asset', condition: compare('stage_one', true), exceptions: [], ruleDependencies: ['service'], conclusion: { predicate: 'stage_two', value: true } },
  'Second layer: stage_one=true from the service rule triggers stage_two=true.'),
  rule('industrial', { ruleId: 'layer-three', objectId: 'asset', condition: compare('stage_two', true), exceptions: [], ruleDependencies: ['layer-two'], conclusion: { predicate: 'ready', value: true } },
  'Third layer: stage_two=true from the second layer triggers ready=true.'),
  rule('industrial', { ruleId: 'alarm', objectId: 'asset', condition: compare('alarm', true), exceptions: [], ruleDependencies: [], conclusion: { predicate: 'stage_one', value: true } },
  'Alarm rule: alarm=true is an independent support for stage_one=true.'),
  rule('industrial', { ruleId: 'service-any', objectId: 'asset', condition: { op: 'any', operands: [{ op: 'range', attributeId: 'hours', min: 100, unitCode: 'h', spans: [] }, compare('alarm', true)], spans: [] },
    exceptions: [], ruleDependencies: [], conclusion: { predicate: 'stage_one', value: true } },
  'Either hours>=100 h or alarm=true supports stage_one=true.'),
] as const

export const COMPETENCY_ASSETS = {
  transport: { definitions: [TRANSPORT_DEFINITION], rules: TRANSPORT_RULES, document: TRANSPORT_DOCUMENT },
  industrial: { definitions: [INDUSTRIAL_DEFINITION, INDUSTRIAL_DEFINITION_V2], rules: INDUSTRIAL_RULES, document: INDUSTRIAL_DOCUMENT },
} as const

/** Independently authored CSV/registered-operation originals; bytes remain separate from gold. */
export const CQ_ADDITIONAL_SOURCES = [
  { industry: "transport", filename: "transport-facility.csv", objectId: "facility", document: competencyFixtureDocument("transport.rows", "facility_code,length,condition,closed,located_in\nF-01,12.5,bad,false,D-01\nF-02,5.0,good,false,\n") },
  { industry: "transport", filename: "transport-alternative.csv", objectId: "facility", document: competencyFixtureDocument("transport.alternative", "facility_code,condition\nF-01,good\n") },
  { industry: "transport", filename: "transport-exception.csv", objectId: "facility", document: competencyFixtureDocument("transport.exception", "facility_code,closed\nF-01,true\n") },
  { industry: "transport", filename: "transport-wrong-unit.csv", objectId: "facility", document: competencyFixtureDocument("transport.wrong-unit", "facility_code,length\nF-01,12.5\n") },
  { industry: "transport", filename: "transport-district.csv", objectId: "district", document: competencyFixtureDocument("transport.district", "district_code,watch\nD-01,true\n") },
  { industry: "transport", filename: "transport-compute-input.json", objectId: undefined, document: competencyFixtureDocument("transport.compute-input", "{\"rows\":[{\"id\":\"stock-a\",\"amount\":\"12.5\",\"unit\":\"each\"},{\"id\":\"stock-b\",\"amount\":\"5.0\",\"unit\":\"each\"}]}\n") },
  { industry: "industrial", filename: "industrial-hours.csv", objectId: "asset", document: competencyFixtureDocument("industrial.rows", "asset_code,hours,exempt,in_workshop\nA-01,120,false,W-01\nA-02,30,false,\n") },
  { industry: "industrial", filename: "industrial-alarm.csv", objectId: "asset", document: competencyFixtureDocument("industrial.alarm", "asset_code,alarm\nA-01,true\nA-02,false\n") },
  { industry: "industrial", filename: "industrial-boundary.csv", objectId: "asset", document: competencyFixtureDocument("industrial.boundary", "asset_code,hours,exempt\nA-03,100,false\n") },
  { industry: "industrial", filename: "industrial-version-two.csv", objectId: "asset", document: competencyFixtureDocument("industrial.version-two", "asset_code,inspection_due\nA-01,true\n") },
  { industry: "industrial", filename: "industrial-workshop.csv", objectId: "workshop", document: competencyFixtureDocument("industrial.workshop", "shop_code,staffed\nW-01,false\n") },
  { industry: "industrial", filename: "industrial-compute-input.json", objectId: undefined, document: competencyFixtureDocument("industrial.compute-input", "{\"rows\":[{\"id\":\"stock-a\",\"amount\":\"3\",\"unit\":\"each\"},{\"id\":\"stock-b\",\"amount\":\"4\",\"unit\":\"each\"},{\"id\":\"cost-a\",\"amount\":\"35\",\"currency\":\"CNY\"},{\"id\":\"cost-b\",\"amount\":\"4\",\"currency\":\"CNY\"}]}\n") },
] as const
