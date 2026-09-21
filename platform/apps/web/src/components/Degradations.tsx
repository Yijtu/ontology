import type { ExplicitDegradation } from '@ontology/contracts'

export interface DegradationsProps {
  readonly degradations: readonly ExplicitDegradation[]
}

/**
 * Every declared-but-reduced capability, with its reason and fallback. An explicit
 * degradation is never hidden: it is shown next to the resolved manifest so the operator
 * knows exactly what was reduced and why.
 */
export function Degradations({ degradations }: DegradationsProps) {
  if (degradations.length === 0) {
    return (
      <section className="degradations" data-testid="degradations" data-count="0">
        <h3>显式降级</h3>
        <p>无显式降级。</p>
      </section>
    )
  }
  return (
    <section className="degradations" data-testid="degradations" data-count={degradations.length}>
      <h3>显式降级（{degradations.length}）</h3>
      <ul>
        {degradations.map((entry) => (
          <li key={`${entry.capability}:${entry.fallbackReason}`} data-testid="degradation">
            <span className="degradations__capability">{entry.capability}</span>
            <span className="degradations__reason">{entry.reason}</span>
            <span className="degradations__fallback">回退：{entry.fallback}</span>
            <span className="degradations__detail">{entry.fallbackReason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
