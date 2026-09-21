import { describe, it } from 'vitest'
import { createAjv, expectInvalid, expectValid, validator } from './helpers'

const ajv = createAjv()
const unitCode = validator(ajv, 'common.schema.json', 'UnitCode')

describe('UnitCode', () => {
  it('accepts a standalone percent sign as documented', () => {
    expectValid(unitCode, '%', 'standalone percent')
  })

  it('accepts the documented canonical tokens', () => {
    for (const code of ['kWh', 'kW', 'Wh', 'W', 'pct', 'm3/h', 'kg*km']) {
      expectValid(unitCode, code, code)
    }
  })

  it('rejects tokens that break the original constraints', () => {
    for (const code of ['', ' ', '%abc', '9kWh', 'kWh ', '-kWh', 'k'.repeat(33)]) {
      expectInvalid(unitCode, code, JSON.stringify(code))
    }
  })

  it('rejects non-string values', () => {
    for (const value of [null, 1, true, {}, ['%']]) {
      expectInvalid(unitCode, value, JSON.stringify(value))
    }
  })
})
