import type { MissingCapability } from '@ontology/contracts'

export interface CapabilityGapsProps {
  readonly missing: readonly MissingCapability[]
}

function rangeOf(range: { readonly min: string; readonly max?: string }): string {
  return range.max === undefined ? `>= ${range.min}` : `${range.min} - ${range.max}`
}

/**
 * The required capabilities the profile could not resolve. They are rendered as gaps and
 * never as available capabilities: an operator must see exactly what is unimplemented.
 */
export function CapabilityGaps({ missing }: CapabilityGapsProps) {
  if (missing.length === 0) return null
  return (
    <section className="capability-gaps" data-testid="capability-gaps">
      <h3>必需能力缺项（{missing.length}）</h3>
      <ul>
        {missing.map((gap) => (
          <li key={gap.name} data-testid="capability-gap" data-capability={gap.name}>
            <span className="capability-gaps__name">{gap.name}</span>
            <span className="capability-gaps__range">{rangeOf(gap.versionRange)}</span>
            <span className="capability-gaps__state" data-state="not_configured">
              未配置
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
