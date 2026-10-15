/**
 * Exact decimal string arithmetic for unit normalisation (SPEC v0.3a §5.3).
 *
 * A quantity must never pass through a JavaScript `Number`, so a conversion is applied as an
 * exact rational factor over `DecimalString`s with `BigInt` scaling. If the result is not
 * representable as a finite decimal within the declared scale the conversion returns
 * `undefined` and the caller keeps the value pending instead of rounding it silently.
 */

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

const MAX_RESULT_SCALE = 40

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value)
}

interface ScaledDecimal {
  readonly value: bigint
  readonly scale: number
}

function scaledOf(decimal: string): ScaledDecimal {
  const negative = decimal.startsWith('-')
  const body = negative ? decimal.slice(1) : decimal
  const dot = body.indexOf('.')
  const digits = dot === -1 ? body : `${body.slice(0, dot)}${body.slice(dot + 1)}`
  const scale = dot === -1 ? 0 : body.length - dot - 1
  const magnitude = digits.length === 0 ? 0n : BigInt(digits)
  return { value: negative ? -magnitude : magnitude, scale }
}

function renderScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString()
  const sign = negative ? '-' : ''
  if (scale === 0) return `${sign}${digits}`
  const padded = digits.padStart(scale + 1, '0')
  const whole = padded.slice(0, padded.length - scale)
  const fraction = padded.slice(padded.length - scale).replace(/0+$/u, '')
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`
}

/**
 * Apply `value * numerator / denominator` exactly. Returns the canonical decimal string, or
 * `undefined` when any operand is malformed, the denominator is zero, or the quotient has no
 * finite decimal representation within `MAX_RESULT_SCALE` fractional digits.
 */
export function applyExactFactor(
  value: string,
  numerator: string,
  denominator: string,
): string | undefined {
  if (!isDecimalString(value) || !isDecimalString(numerator) || !isDecimalString(denominator)) {
    return undefined
  }
  const v = scaledOf(value)
  const n = scaledOf(numerator)
  const d = scaledOf(denominator)
  if (d.value === 0n) return undefined

  // result = (v.value / 10^v.scale) * (n.value / 10^n.scale) / (d.value / 10^d.scale)
  //        = (v.value * n.value * 10^d.scale) / (10^(v.scale + n.scale) * d.value)
  let a = v.value * n.value * 10n ** BigInt(d.scale)
  let b = d.value * 10n ** BigInt(v.scale + n.scale)
  if (b < 0n) {
    a = -a
    b = -b
  }
  for (let k = 0; k <= MAX_RESULT_SCALE; k += 1) {
    const scaledNumerator = a * 10n ** BigInt(k)
    if (scaledNumerator % b === 0n) {
      return renderScaled(scaledNumerator / b, k)
    }
  }
  return undefined
}
