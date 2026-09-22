import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Structural purity proof (INV-02, SPEC §2.2, ADR-11): the generic tool service must never
 * import the home-energy extension. The energy compute handlers are bound to `data_query` by
 * declaration at the composition root, so the tool service stays industry-independent.
 */

const platformRoot = fileURLToPath(new URL('../..', import.meta.url))
const TOOL_SERVICES_SRC = join(platformRoot, 'packages', 'tool-services', 'src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs))
    } else if (entry.endsWith('.ts')) {
      out.push(abs)
    }
  }
  return out
}

const IMPORT_PATTERN = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g

describe('packages/tool-services purity', () => {
  it('never imports the home-energy extension or any industry package', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(TOOL_SERVICES_SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? ''
        if (/home-energy|extension-|industry-pack/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('declares no home-energy dependency in its package manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(platformRoot, 'packages', 'tool-services', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]
    expect(declared.filter((name) => /home-energy|extension-/.test(name))).toEqual([])
  })
})
