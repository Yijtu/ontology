import type { VersionRef } from '@ontology/contracts'
import { EnergyInputError } from './errors'
import { CANONICAL_UNIT, type EnergyMetric } from './types'

/**
 * Declared physical → canonical conversions (SPEC E1/E2/E4, INV-03, E-01).
 *
 * The extension never hardcodes a unit factor or an SOC curve. Every conversion is declared,
 * versioned and validated against the canonical unit for its metric; an undeclared conversion
 * is refused with a typed error rather than approximated. A state-of-charge series is likewise
 * only usable through a declared SOC mapping and a declared device SOC→energy mapping.
 */

export interface UnitConversionDeclaration {
  readonly conversionRef: VersionRef
  readonly metric: EnergyMetric
  readonly sourceUnit: string
  readonly canonicalUnit: string
  /** canonical = source × factor + offset */
  readonly factor: number
  readonly offset?: number
}

export interface SocConversionDeclaration {
  readonly conversionRef: VersionRef
  readonly sourceUnit: string
  readonly canonicalUnit: 'ratio'
  /** ratio = source × factor + offset */
  readonly factor: number
  readonly offset?: number
}

export interface SocToEnergyDeclaration {
  readonly conversionRef: VersionRef
  readonly deviceRef: string
  readonly energyCapacityKwh: number
  /** energy_kwh = ratio × energyCapacityKwh × factor + offset */
  readonly factor: number
  readonly offset?: number
}

export interface DeclaredConversionSet {
  readonly unitConversions: readonly UnitConversionDeclaration[]
  readonly socConversions: readonly SocConversionDeclaration[]
  readonly socToEnergy: readonly SocToEnergyDeclaration[]
}

function assertFinite(value: number, label: string, ref: VersionRef): void {
  if (!Number.isFinite(value)) {
    throw new EnergyInputError('INVALID_DECLARATION', `${label} in ${ref.id} is not a finite number`)
  }
}

export class DeclaredConversions {
  readonly #unitConversions: readonly UnitConversionDeclaration[]
  readonly #socConversions: readonly SocConversionDeclaration[]
  readonly #socToEnergy: readonly SocToEnergyDeclaration[]

  constructor(set: DeclaredConversionSet) {
    for (const declaration of set.unitConversions) {
      const expected = CANONICAL_UNIT[declaration.metric]
      if (declaration.canonicalUnit !== expected) {
        throw new EnergyInputError(
          'INVALID_DECLARATION',
          `${declaration.conversionRef.id} declares ${declaration.metric} in ${declaration.canonicalUnit}, expected ${expected}`,
        )
      }
      assertFinite(declaration.factor, 'factor', declaration.conversionRef)
      if (declaration.offset !== undefined) {
        assertFinite(declaration.offset, 'offset', declaration.conversionRef)
      }
    }
    for (const declaration of set.socConversions) {
      assertFinite(declaration.factor, 'factor', declaration.conversionRef)
      if (declaration.offset !== undefined) {
        assertFinite(declaration.offset, 'offset', declaration.conversionRef)
      }
    }
    for (const declaration of set.socToEnergy) {
      assertFinite(declaration.energyCapacityKwh, 'energyCapacityKwh', declaration.conversionRef)
      assertFinite(declaration.factor, 'factor', declaration.conversionRef)
      if (declaration.offset !== undefined) {
        assertFinite(declaration.offset, 'offset', declaration.conversionRef)
      }
    }
    this.#unitConversions = [...set.unitConversions]
    this.#socConversions = [...set.socConversions]
    this.#socToEnergy = [...set.socToEnergy]
  }

  resolveUnit(metric: EnergyMetric, sourceUnit: string): UnitConversionDeclaration {
    if (metric === 'state_of_charge') {
      throw new EnergyInputError(
        'UNDECLARED_CONVERSION',
        'state_of_charge must be converted through a declared SOC mapping, not a unit factor',
      )
    }
    const declaration = this.#unitConversions.find(
      (candidate) => candidate.metric === metric && candidate.sourceUnit === sourceUnit,
    )
    if (declaration === undefined) {
      throw new EnergyInputError(
        'UNDECLARED_CONVERSION',
        `no declared conversion for ${metric} from unit ${sourceUnit}`,
      )
    }
    return declaration
  }

  resolveSoc(sourceUnit: string): SocConversionDeclaration {
    const declaration = this.#socConversions.find((candidate) => candidate.sourceUnit === sourceUnit)
    if (declaration === undefined) {
      throw new EnergyInputError(
        'UNDECLARED_SOC_MAPPING',
        `no declared SOC mapping from unit ${sourceUnit}`,
      )
    }
    return declaration
  }

  resolveSocToEnergy(deviceRef: string): SocToEnergyDeclaration {
    const declaration = this.#socToEnergy.find((candidate) => candidate.deviceRef === deviceRef)
    if (declaration === undefined) {
      throw new EnergyInputError(
        'UNDECLARED_SOC_MAPPING',
        `no declared SOC→energy mapping for device ${deviceRef}`,
      )
    }
    return declaration
  }

  /** Convert one sample into the canonical unit. Undeclared input is refused. */
  convert(metric: EnergyMetric, sourceUnit: string, value: number): number {
    if (metric === 'state_of_charge') {
      const declaration = this.resolveSoc(sourceUnit)
      return value * declaration.factor + (declaration.offset ?? 0)
    }
    const declaration = this.resolveUnit(metric, sourceUnit)
    return value * declaration.factor + (declaration.offset ?? 0)
  }

  /** Convert a canonical SOC ratio into energy through the declared device mapping. */
  socToEnergy(deviceRef: string, ratio: number): number {
    const declaration = this.resolveSocToEnergy(deviceRef)
    return ratio * declaration.energyCapacityKwh * declaration.factor + (declaration.offset ?? 0)
  }
}
