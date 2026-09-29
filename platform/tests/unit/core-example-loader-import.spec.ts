// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { loadCoreExamples } from '../../apps/api/src/composition/core-example-loader'

describe('Core example loader module initialization', () => {
  it('can be imported in a browser-based test without resolving its Node asset path eagerly', () => {
    expect(loadCoreExamples).toBeTypeOf('function')
  })
})
