import { describe, expect, it } from 'vitest'
import type { IndustrySchema } from '@ontology/contracts'
import { canonicalDecimalString, validateRuleConclusionBinding } from '@ontology/core'

const schema: IndustrySchema = {
  namespace: 'synthetic.maintenance',
  definitionRef: { id: 'maintenance', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
  objects: [
    {
      objectId: 'facility',
      displayName: 'Facility',
      identityScopeId: 'facility.identity',
      attributes: [
        { attributeId: 'inspection_due', valueType: 'boolean', minCardinality: 0, maxCardinality: 1, identityKey: false },
        { attributeId: 'interval_hours', valueType: 'quantity', minCardinality: 0, maxCardinality: 1, identityKey: false, unitCode: 'h' },
        { attributeId: 'condition', valueType: 'enum', minCardinality: 0, maxCardinality: 1, identityKey: false, enumValues: ['good', 'poor'] },
        { attributeId: 'reading', valueType: 'number', minCardinality: 0, maxCardinality: 1, identityKey: false },
      ],
    },
    {
      objectId: 'vehicle',
      displayName: 'Vehicle',
      identityScopeId: 'vehicle.identity',
      attributes: [
        { attributeId: 'inspection_due', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
      ],
    },
  ],
  relations: [],
  identityScopes: [],
}

describe('reviewed rule conclusion bindings', () => {
  it('binds only an attribute on the same scoped object and preserves exact values', () => {
    expect(validateRuleConclusionBinding({ predicate: 'inspection_due', value: true }, 'facility', schema)).toEqual({
      binding: { predicate: 'inspection_due', value: true },
    })
    expect(validateRuleConclusionBinding({ predicate: 'inspection_due', value: 'due' }, 'facility', schema).reason)
      .toContain('boolean')
    expect(validateRuleConclusionBinding({ predicate: 'inspection_due', value: 'due' }, 'vehicle', schema)).toEqual({
      binding: { predicate: 'inspection_due', value: 'due' },
    })
  })

  it('checks enum and exact quantity values and rejects undeclared or multi-valued conclusions', () => {
    expect(validateRuleConclusionBinding({ predicate: 'condition', value: 'poor' }, 'facility', schema).binding)
      .toEqual({ predicate: 'condition', value: 'poor' })
    expect(validateRuleConclusionBinding({ predicate: 'condition', value: 'unknown' }, 'facility', schema).reason)
      .toContain('enum')
    expect(validateRuleConclusionBinding({ predicate: 'interval_hours', value: { amount: '6.000e3', unit: 'h' } }, 'facility', schema).binding)
      .toEqual({ predicate: 'interval_hours', value: { amount: '6000', unit: 'h' } })
    expect(validateRuleConclusionBinding({ predicate: 'interval_hours', value: { amount: '6000', unit: 'min' } }, 'facility', schema).reason)
      .toContain('unit h')
    expect(validateRuleConclusionBinding({ predicate: 'missing', value: true }, 'facility', schema).reason)
      .toContain('not declared')
    expect(validateRuleConclusionBinding({ predicate: 'inspection_due', value: true }, 'missing', schema).reason)
      .toContain('object missing')
  })

  it('normalizes exact decimal text without float rounding', () => {
    expect(canonicalDecimalString('5999')).toBe('5999')
    expect(canonicalDecimalString('6e3')).toBe('6000')
    expect(canonicalDecimalString('NaN')).toBeUndefined()
    expect(canonicalDecimalString('Infinity')).toBeUndefined()
  })

  it('accepts a tagged unitless number only for its declared numeric attribute', () => {
    const value = { kind: 'scalar_decimal', amount: '-9007199254740993.10000000000000001' }
    expect(validateRuleConclusionBinding({ predicate: 'reading', value }, 'facility', schema).binding).toEqual({ predicate: 'reading', value })
    expect(validateRuleConclusionBinding({ predicate: 'inspection_due', value }, 'facility', schema).reason).toContain('boolean')
    expect(validateRuleConclusionBinding({ predicate: 'interval_hours', value }, 'facility', schema).reason).toContain('amount and unit')
    expect(validateRuleConclusionBinding({ predicate: 'reading', value: { ...value, unit: 'kW' } }, 'facility', schema).reason).toContain('unitless')
    expect(validateRuleConclusionBinding({ predicate: 'reading', value: { ...value, amount: '1e5' } }, 'facility', schema).reason).toContain('exact')
  })
})
