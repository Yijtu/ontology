import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ADAPTER_DIR = fileURLToPath(
  new URL('../../packages/adapters/runtime-template/src', import.meta.url),
)
const ADAPTER_MANIFEST = fileURLToPath(
  new URL('../../packages/adapters/runtime-template/package.json', import.meta.url),
)

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(absolute)
  }
  return found
}

function read(): { readonly file: string; readonly source: string }[] {
  return sourceFiles(ADAPTER_DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') }))
}

/**
 * The template runtime is an adapter: it may import `@ontology/contracts` and
 * `@ontology/core`, but never the application layer, another adapter, an extension, an
 * industry pack, a service layer or an SDK/driver. The architecture test enforces the
 * workspace graph; this scan additionally pins the concrete module specifiers.
 */
const FORBIDDEN_IMPORTS = [
  /from '@ontology\/application'/,
  /from '@ontology\/app-/,
  /from '@ontology\/adapter-/,
  /from '@ontology\/extension-/,
  /from '@ontology\/industry-pack-/,
  /from '@ontology\/tool-services'/,
  /from '@ontology\/semantic-engine'/,
  /from '@ontology\/provenance'/,
  /industry-packs/,
  /from 'pg'/,
  /from 'postgres'/,
  /from 'fastify'/,
  /from 'express'/,
  /from 'koa'/,
  /from 'undici'/,
  /from 'duckdb'/,
  /@modelcontextprotocol\/sdk/,
  /from 'node:fs'/,
  /from 'node:child_process'/,
  /from 'node:net'/,
  /from 'node:http'/,
]

/**
 * A publication path would be a controller service (`verify_result`/`final_answer`) or an
 * answer publisher. The runtime must not name or reach one: its terminal event is
 * `collection_complete`, which only means a draft may be attempted (INV-09).
 */
const FORBIDDEN_PUBLICATION_TOKENS = [
  'final_answer',
  'verify_result',
  'answerRepo',
  'publishAnswer',
  'AnswerPublisher',
  'PublicationService',
  'answer.published',
]

describe('template runtime layering (SPEC §2, INV-02/INV-04/INV-09)', () => {
  it('imports only contracts and core, never the application layer, another adapter or an SDK/driver', () => {
    const files = read()
    expect(files.length).toBeGreaterThan(0)
    for (const { file, source } of files) {
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(source, `${file} must not match ${String(pattern)}`).not.toMatch(pattern)
      }
    }
  })

  it('declares only contracts and core as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(ADAPTER_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@ontology/contracts',
      '@ontology/core',
    ])
  })

  it('has no publication path and never claims a published answer', () => {
    for (const { file, source } of read()) {
      for (const token of FORBIDDEN_PUBLICATION_TOKENS) {
        expect(source, `${file} must not reference ${token}`).not.toContain(token)
      }
    }
  })

  it('does not open a database, filesystem or network handle', () => {
    for (const { file, source } of read()) {
      expect(source, `${file} must not open a database connection`).not.toMatch(/new Pool|Client\(/)
      expect(source, `${file} must not read the filesystem`).not.toMatch(/readFile|createReadStream|readdir/)
      expect(source, `${file} must not open a network handle`).not.toMatch(/fetch\(|net\.connect|createServer/)
    }
  })
})
