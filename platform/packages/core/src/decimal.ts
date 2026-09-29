/** Convert exact decimal/scientific text to a plain decimal without using IEEE-754. */
export function canonicalDecimalString(text: string): string | undefined {
  if (text.length === 0 || text.length > 64) return undefined
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (match === null) return undefined
  const signText = match[1] ?? ''
  const integerPart = match[2] ?? '0'
  const fractionPart = match[3] ?? match[4] ?? ''
  const exponentText = match[5] ?? '0'
  const exponent = Number(exponentText)
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1_000) return undefined

  const digits = `${integerPart}${fractionPart}`
  const point = integerPart.length + exponent
  const resultLength = point <= 0
    ? 2 + -point + digits.length
    : point >= digits.length
      ? point
      : digits.length + 1
  if (resultLength > 1_024) return undefined

  let expanded: string
  if (point <= 0) expanded = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) expanded = `${digits}${'0'.repeat(point - digits.length)}`
  else expanded = `${digits.slice(0, point)}.${digits.slice(point)}`

  const [rawInteger = '0', rawFraction = ''] = expanded.split('.')
  const integer = rawInteger.replace(/^0+(?=\d)/, '') || '0'
  const fraction = rawFraction.replace(/0+$/, '')
  if (integer === '0' && fraction === '') return '0'
  return `${signText === '-' ? '-' : ''}${integer}${fraction === '' ? '' : `.${fraction}`}`
}
