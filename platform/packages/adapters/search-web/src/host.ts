/**
 * Host/allowlist matching shared by the search provider and the snapshot archiver.
 *
 * A result is inside the allowlist when its host equals an approved domain or is a subdomain of
 * one. Anything else is outside: a lookalike (`notexample.com`) or a foreign TLD must never pass.
 * The comparison is case-insensitive and performs no DNS resolution, so it is a pure string rule
 * both call sites can rely on identically.
 */
export function hostAllowed(pageUrl: string, allowedDomains: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(pageUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((domain) => {
    const candidate = domain.toLowerCase()
    return host === candidate || host.endsWith(`.${candidate}`)
  })
}
