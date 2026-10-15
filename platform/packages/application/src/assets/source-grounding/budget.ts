import { SourceGroundingError } from '@ontology/contracts'
import type { GroundedSourceContent, SourceGroundingBudgetPort, SourceGroundingLimits,
  SourceGroundingReason, SourceGroundingUsage } from '@ontology/contracts'

export const DEFAULT_SOURCE_GROUNDING_LIMITS: SourceGroundingLimits = {
  fragments: 32, bytes: 64 * 1024, inputTokens: 64 * 1024, pages: 16, readBytes: 32 * 1024 * 1024,
}

export class SourceGroundingBudget implements SourceGroundingBudgetPort {
  readonly #limits: SourceGroundingLimits
  #used = { fragments: 0, bytes: 0, inputTokens: 0, pages: 0, readBytes: 0 }
  constructor(readonly signal: AbortSignal, limits: Partial<SourceGroundingLimits> = {}) {
    this.#limits = { ...DEFAULT_SOURCE_GROUNDING_LIMITS, ...limits }
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new SourceGroundingError('INVALID_REQUEST', 'grounding limits must be nonnegative integers')
      }
    }
  }
  get remainingFragments(): number { return this.#limits.fragments - this.#used.fragments }
  check(): void {
    if (this.signal.aborted) throw new SourceGroundingError('CANCELLED', 'source grounding was cancelled')
  }
  chargeRead(bytes: number): void {
    this.check()
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#used.readBytes + bytes > this.#limits.readBytes) {
      throw new SourceGroundingError('READ_BYTE_LIMIT', 'the shared source read budget is exhausted')
    }
    this.#used.readBytes += bytes
  }
  chargePage(): void {
    this.check()
    if (this.#used.pages >= this.#limits.pages) {
      throw new SourceGroundingError('PAGE_LIMIT', 'the shared source page budget is exhausted')
    }
    this.#used.pages += 1
  }
  accept(content: GroundedSourceContent): SourceGroundingReason | undefined {
    this.check()
    const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength
    const fragments = content.kind === 'text' ? 1 : Math.max(1, content.rows.length)
    if (this.#used.fragments + fragments > this.#limits.fragments) return 'FRAGMENT_LIMIT'
    if (this.#used.bytes + bytes > this.#limits.bytes) return 'BYTE_LIMIT'
    if (this.#used.inputTokens + bytes > this.#limits.inputTokens) return 'TOKEN_LIMIT'
    this.#used.fragments += fragments
    this.#used.bytes += bytes
    this.#used.inputTokens += bytes
    return undefined
  }
  usage(): SourceGroundingUsage { return { ...this.#used } }
}
