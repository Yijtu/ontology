import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkWorkspace, formatViolations, layerOf, loadConfig, type Violation } from './boundaries'

const config = loadConfig(new URL('./boundaries.config.json', import.meta.url))
const platformRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixtureRoot = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const rulesOf = (violations: readonly Violation[]): string[] =>
  [...new Set(violations.map((v) => v.rule))].sort()

describe('layer mapping', () => {
  it('covers every layer named in the acceptance criteria', () => {
    expect(layerOf('packages/contracts')).toBe('contracts')
    expect(layerOf('packages/core')).toBe('core')
    expect(layerOf('packages/application')).toBe('application')
    expect(layerOf('packages/adapters/data-postgres')).toBe('adapters')
    expect(layerOf('industry-packs/home-energy')).toBe('industry-packs')
    expect(layerOf('packages/extensions/home-energy')).toBe('extensions')
    expect(layerOf('apps/api')).toBe('apps')
  })
})

describe('dependency boundaries', () => {
  it('reports no violations for the real workspace', () => {
    expect(formatViolations(checkWorkspace(platformRoot, config))).toBe('')
  })

  it('accepts legal dependencies in the positive fixture', () => {
    expect(formatViolations(checkWorkspace(fixtureRoot('positive'), config))).toBe('')
  })

  it('rejects the negative fixture with every rule', () => {
    const violations = checkWorkspace(fixtureRoot('negative'), config)

    expect(formatViolations(violations)).not.toBe('')
    expect(rulesOf(violations)).toEqual([
      'cross-package-relative-import',
      'forbidden-sdk',
      'workspace-dependency',
    ])
    expect(violations).toHaveLength(7)
  })

  it('forbids core from importing an SDK or driver', () => {
    const violations = checkWorkspace(fixtureRoot('negative'), config)
    const match = violations.find((v) => v.file === 'packages/core/src/forbidden-sdk.ts')

    expect(match).toMatchObject({ rule: 'forbidden-sdk', specifier: 'pg', line: 1 })
  })

  it('forbids core from importing an adapter package', () => {
    const violations = checkWorkspace(fixtureRoot('negative'), config)
    const match = violations.find((v) => v.file === 'packages/core/src/workspace-dependency.ts')

    expect(match).toMatchObject({
      rule: 'workspace-dependency',
      specifier: '@ontology/adapter-data-postgres',
    })
  })

  it('forbids core from importing the home-energy extension', () => {
    const violations = checkWorkspace(fixtureRoot('negative'), config)
    const match = violations.find((v) => v.file === 'packages/application/src/extension-import.ts')

    expect(match).toMatchObject({
      rule: 'workspace-dependency',
      specifier: '@ontology/extension-home-energy',
    })
  })

  it('forbids relative imports that escape the package root', () => {
    const violations = checkWorkspace(fixtureRoot('negative'), config)
    const match = violations.find((v) => v.file === 'packages/core/src/escape.ts')

    expect(match).toMatchObject({ rule: 'cross-package-relative-import' })
  })
})
