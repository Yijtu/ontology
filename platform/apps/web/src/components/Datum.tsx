import type { ReactNode } from 'react'

/**
 * A labelled datum (SPEC E1/E8; INV-10).
 *
 * Every number the energy UI shows is wrapped in one of these, so a reader always sees the
 * value together with its **unit**, its **source**, its **time** and its data **mode**
 * (`synthetic` / `forecast` / `observed`). The mode is a required prop rather than a default:
 * a datum cannot be rendered without stating where it came from, and a simulated value can
 * therefore never be presented as an observed measurement or an actual bill.
 */
export type DatumMode = 'synthetic' | 'forecast' | 'observed' | 'simulated'

export interface DatumProps {
  readonly label: string
  readonly value: number | string
  readonly unit: string
  readonly source: string
  readonly time: string
  readonly mode: DatumMode
  /** An optional explicit kind, e.g. `simulated_saving` for the simulation-only benefit figure. */
  readonly kind?: string
  readonly testId?: string
  readonly children?: ReactNode
}

export function Datum({ label, value, unit, source, time, mode, kind, testId, children }: DatumProps) {
  return (
    <span className="datum" data-testid={testId ?? 'datum'} data-mode={mode} data-kind={kind}>
      <span className="datum__label">{label}</span>
      <span className="datum__value" data-testid="datum-value">
        {value}
      </span>
      <span className="datum__unit" data-testid="datum-unit">
        {unit}
      </span>
      <span className="datum__source" data-testid="datum-source">
        {source}
      </span>
      <span className="datum__time" data-testid="datum-time">
        {time}
      </span>
      <span className="datum__mode" data-testid="datum-mode">
        {mode}
      </span>
      {children}
    </span>
  )
}
