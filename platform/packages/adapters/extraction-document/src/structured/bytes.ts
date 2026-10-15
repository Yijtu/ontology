import { createHash } from 'node:crypto'
import type { DecimalString, Sha256Digest } from '@ontology/contracts'

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256DigestOf(bytes: Uint8Array): Sha256Digest {
  return `sha256:${sha256Hex(bytes)}`
}

export function sha256DigestOfText(text: string): Sha256Digest {
  return sha256DigestOf(new TextEncoder().encode(text))
}

/**
 * The identity normalization map: the parser preserves the original bytes and
 * records half-open byte ranges into them, so the map root is the original's
 * digest. A locator that quotes it can be re-checked against the same bytes.
 */
export function identityNormalizationMapRef(originalBytes: Uint8Array): string {
  return sha256DigestOf(originalBytes)
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  )
}

export function bomLength(bytes: Uint8Array): number {
  return hasUtf8Bom(bytes) ? 3 : 0
}

/** Strict UTF-8 decode: an invalid sequence is a hard `INVALID_UTF8` failure. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`invalid UTF-8 byte sequence: ${String(error)}`)
  }
}

const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/**
 * A canonical DecimalString, or `undefined` when the raw token is a number we
 * can read (e.g. exponent notation) but cannot claim without rewriting it.
 */
export function canonicalDecimal(raw: string): DecimalString | undefined {
  if (raw.length === 0 || raw.length > 64) return undefined
  if (!CANONICAL_DECIMAL.test(raw)) return undefined
  return raw as DecimalString
}
