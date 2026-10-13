import type { GenerationPort } from '@ontology/contracts'
import { CoreFactsPlanError } from './core-facts-plan'

/** Classified Core errors and the disabled-model ports the composition falls back to. */

export function noModelError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: 'CAPABILITY_NOT_CONFIGURED' })
}

export function disabledDecision() {
  return {
    decide: async () => { throw noModelError('the JEV decision model is not configured') },
  }
}

export const DISABLED_GENERATION: GenerationPort = {
  async *generate() {
    throw new CoreCapabilityError('the generative extraction model is not configured')
  },
}

export class CoreCapabilityError extends Error {
  readonly code = 'CAPABILITY_NOT_CONFIGURED'
  readonly httpStatus = 409

  constructor(message: string) {
    super(message)
    this.name = 'CoreCapabilityError'
  }
}

export class CoreFactsRequestError extends Error {
  readonly code: string
  readonly httpStatus = 422

  constructor(error: CoreFactsPlanError) {
    super(error.message)
    this.name = 'CoreFactsRequestError'
    this.code = error.code
  }
}
