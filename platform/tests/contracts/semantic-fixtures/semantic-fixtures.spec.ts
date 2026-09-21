import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ValidateFunction } from 'ajv'
import {
  SCENARIO_KINDS,
  canonicalJson,
  canonicalize,
  createCanonicalAjv,
  createFixtureValidator,
  fixtureSetDigest,
  loadFixtures,
  schemaRef,
  semanticFixtureDir,
} from '../../fixtures/semantic/loader'
import { platformRoot } from '../helpers'

const repoRoot = join(platformRoot, '..')

/**
 * LOCAL-048 contract suite: the fixtures are the shared regression input and
 * gold for LOCAL-032/033/034/054. This suite proves the fixtures are
 * spec-derived, schema-valid, deterministically loadable and cover every
 * required scenario. It does not evaluate rules or materialise projections —
 * that is the consumers' job.
 */
const fixtures = loadFixtures()

function canonicalDef(ajv: ReturnType<typeof createCanonicalAjv>, file: string, def: string): ValidateFunction {
  const validate = ajv.getSchema(schemaRef(file, def))
  if (validate === undefined) throw new Error(`canonical schema ${file}#${def} is not registered`)
  return validate
}

describe('semantic regression fixtures', () => {
  it('validates every fixture against the @ontology/contracts schemas', () => {
    const validate = createFixtureValidator()
    const files = readdirSync(semanticFixtureDir)
      .filter((name) => name.endsWith('.fixture.json'))
      .sort()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(join(semanticFixtureDir, file), 'utf8'))
      expect(validate(raw), `${file}\n${JSON.stringify(validate.errors, null, 2)}`).toBe(true)
    }
  })

  it('validates embedded contract objects with the canonical schemas directly', () => {
    const ajv = createCanonicalAjv()
    const scopeRef = canonicalDef(ajv, 'common.schema.json', 'ScopeRef')
    const validity = canonicalDef(ajv, 'common.schema.json', 'ValidityInterval')
    const filter = canonicalDef(ajv, 'data.schema.json', 'SemanticFilter')
    const request = canonicalDef(ajv, 'data.schema.json', 'ControlReadProjectionRequest')
    const evidence = canonicalDef(ajv, 'evidence.schema.json', 'EvidenceEnvelope')

    for (const fixture of fixtures) {
      expect(scopeRef(fixture.scopeRef), `${fixture.fixtureId} scopeRef`).toBe(true)
      for (const assertion of fixture.assertions) {
        expect(validity(assertion.validity), `${fixture.fixtureId} ${assertion.assertionId}`).toBe(true)
      }
      for (const rule of fixture.rules) {
        for (const group of rule.premiseGroups) {
          expect(filter(group.filter), `${fixture.fixtureId} ${group.groupId}`).toBe(true)
        }
      }
      for (const view of fixture.expected.views) {
        expect(request(view.request), `${fixture.fixtureId} ${view.viewId}`).toBe(true)
      }
      for (const envelope of fixture.evidence) {
        expect(evidence(envelope), `${fixture.fixtureId} ${envelope.evidenceId}`).toBe(true)
      }
    }
  })

  it('covers every required regression scenario', () => {
    const covered = new Set(fixtures.map((fixture) => fixture.scenarioKind))
    for (const kind of SCENARIO_KINDS) {
      expect(covered.has(kind), `missing scenario ${kind}`).toBe(true)
    }
  })

  it('points every provenance reference at a file in the current SPEC/PRD', () => {
    for (const fixture of fixtures) {
      expect(fixture.provenance.specRefs.length).toBeGreaterThan(0)
      for (const specRef of fixture.provenance.specRefs) {
        const file = specRef.split('#')[0] ?? ''
        expect(file.startsWith('tasks/'), `${specRef} must be a tasks/ SPEC path`).toBe(true)
        expect(existsSync(join(repoRoot, file)), `${specRef} does not exist in this repository`).toBe(true)
      }
      expect(fixture.provenance.derivation.length).toBeGreaterThan(0)
    }
  })

  it('loads and canonicalises deterministically across independent runs', () => {
    const first = loadFixtures()
    const second = loadFixtures()
    expect(fixtureSetDigest(first)).toBe(fixtureSetDigest(second))
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(canonicalize(canonicalize(first))).toEqual(canonicalize(first))
    expect(fixtureSetDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('gives each fixture one current view, declared evidence and bound scope', () => {
    for (const fixture of fixtures) {
      const current = fixture.expected.views.filter((view) => view.isCurrent)
      expect(current, `${fixture.fixtureId} current views`).toHaveLength(1)
      expect(fixture.expected.evidenceConditions.length).toBeGreaterThan(0)
      expect(fixture.operations.length).toBeGreaterThan(0)

      const declaredEvidence = new Set(fixture.evidence.map((envelope) => envelope.evidenceId))
      for (const condition of fixture.expected.evidenceConditions) {
        expect(declaredEvidence.has(condition.evidenceId), `${fixture.fixtureId} ${condition.evidenceId}`).toBe(true)
      }

      for (const view of fixture.expected.views) {
        expect(view.request.scopeRef).toEqual(fixture.scopeRef)
      }
      for (const envelope of fixture.evidence) {
        expect(envelope.scopeRef).toEqual(fixture.scopeRef)
      }

      const assertionIds = fixture.assertions.map((assertion) => assertion.assertionId)
      expect(new Set(assertionIds).size).toBe(assertionIds.length)
    }
  })

  it('explains every rule alternative that references an unpublished assertion', () => {
    for (const fixture of fixtures) {
      const declared = new Set(fixture.assertions.map((assertion) => assertion.assertionId))
      const dangling = fixture.rules.flatMap((rule) =>
        rule.premiseGroups.flatMap((group) =>
          group.alternatives.filter((alternative) => !declared.has(alternative.assertionId)),
        ),
      )
      if (dangling.length > 0) {
        expect(fixture.notes ?? [], `${fixture.fixtureId} needs a note for ${dangling.length} dangling alternative(s)`).not.toHaveLength(0)
      }
    }
  })

  it('stays declarative: no proof counts, field layout or test counts', () => {
    const forbidden = ['proofCount', 'proof_count', 'expectedProofs', 'fieldLayout', 'testCount']
    for (const file of readdirSync(semanticFixtureDir).filter((name) => name.endsWith('.fixture.json'))) {
      const text = readFileSync(join(semanticFixtureDir, file), 'utf8')
      for (const token of forbidden) {
        expect(text.includes(token), `${file} must not encode ${token}`).toBe(false)
      }
    }
  })

  it('keeps the loader free of clock, randomness, network and external processes', () => {
    const source = readFileSync(join(semanticFixtureDir, 'loader.ts'), 'utf8')
    const forbidden = [
      'Math.random',
      'Date.now',
      'new Date(',
      'performance.now',
      'node:http',
      'node:https',
      'node:net',
      'node:child_process',
      'fetch(',
      'XMLHttpRequest',
    ]
    for (const token of forbidden) {
      expect(source.includes(token), `loader.ts must not use ${token}`).toBe(false)
    }
  })
})
