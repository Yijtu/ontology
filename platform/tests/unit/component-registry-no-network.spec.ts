import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APPLICATION_SRC = fileURLToPath(new URL('../../packages/application/src', import.meta.url))

const FORBIDDEN_SPECIFIERS = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dns',
  'node:dgram',
  'node:child_process',
  'http',
  'https',
  'undici',
  'axios',
  'node-fetch',
]

const FORBIDDEN_CALLS = [/\bfetch\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(absolute)
  }
  return out
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A package can only be installed from a network fetch if the application layer can
 * reach a network primitive. This scan proves none is imported, and that there is no
 * dynamic `import()`/`require()` a manifest could steer to arbitrary code.
 */
describe('application layer cannot install code dynamically', () => {
  it('imports no network primitive and performs no dynamic import', () => {
    const violations: string[] = []
    for (const file of sourceFiles(APPLICATION_SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        const escaped = escapeForRegExp(specifier)
        const pattern = new RegExp(
          `from\\s+['"]${escaped}['"]|require\\(\\s*['"]${escaped}['"]\\s*\\)|import\\(\\s*['"]${escaped}['"]\\s*\\)`,
        )
        if (pattern.test(text)) violations.push(`${file}: imports ${specifier}`)
      }
      for (const call of FORBIDDEN_CALLS) {
        if (call.test(text)) violations.push(`${file}: matches ${String(call)}`)
      }
    }
    expect(violations).toEqual([])
  })
})
