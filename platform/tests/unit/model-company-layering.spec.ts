import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type { GenerationPort } from '@ontology/contracts'

const ADAPTER_DIR = fileURLToPath(new URL('../../packages/adapters/model-company/src', import.meta.url))
const CONTRACTS_DIR = fileURLToPath(new URL('../../packages/contracts/src', import.meta.url))
const CORE_DIR = fileURLToPath(new URL('../../packages/core/src', import.meta.url))

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(absolute)
  }
  return found
}

function read(dir: string): { readonly file: string; readonly source: string }[] {
  return sourceFiles(dir).map((file) => ({ file, source: readFileSync(file, 'utf8') }))
}

const FORBIDDEN_ADAPTER_IMPORTS = [
  /from '@ontology\/application'/,
  /from '@ontology\/app-/,
  /from '@ontology\/adapter-/,
  /from '@ontology\/extension-/,
  /from '@ontology\/industry-pack-/,
  /industry-packs/,
  /from 'pg'/,
  /from 'fastify'/,
  /from 'express'/,
  /from 'koa'/,
  /from 'undici'/,
]

/** Vendor-specific identifiers that must never reach the canonical contracts or core. */
const VENDOR_TOKENS = [
  'CompanyWire',
  'company-wire',
  'company-wire',
  'call_id',
  'args_delta',
  'prompt_tokens',
  'completion_tokens',
  'finish_reason',
  'error_message',
  'vendorModel',
  // OpenAI-compatible wire vocabulary must stay inside the adapter codec too.
  'OpenAiStreamChunk',
  'openai-wire',
  'chat.completion',
]

describe('model-company adapter layering (SPEC §2, §4.2)', () => {
  it('depends on contracts and core only, never on another adapter or the application layer', () => {
    for (const { file, source } of read(ADAPTER_DIR)) {
      for (const pattern of FORBIDDEN_ADAPTER_IMPORTS) {
        expect(source, `${file} must not match ${String(pattern)}`).not.toMatch(pattern)
      }
    }
  })

  it('keeps the vendor wire types out of the public surface', () => {
    const index = readFileSync(join(ADAPTER_DIR, 'index.ts'), 'utf8')
    expect(index).not.toMatch(/vendor\//)
    expect(index).not.toMatch(/CompanyWire/)
    expect(index).not.toMatch(/CompanyApi/)
    expect(index).not.toMatch(/OpenAi/)
    expect(index).not.toMatch(/openai/)
    for (const { file, source } of read(ADAPTER_DIR)) {
      if (file.endsWith('index.ts')) continue
      // The vendor module itself is allowed to name its own types; nothing else may.
      if (file.includes(`${join('src', 'vendor')}`)) continue
      expect(source, `${file} must not re-export a vendor type`).not.toMatch(
        /export .*CompanyWire/,
      )
      expect(source, `${file} must not re-export an OpenAI wire type`).not.toMatch(/export .*OpenAi/)
    }
  })

  it('does not reference any vendor identifier from contracts or core', () => {
    for (const { file, source } of [...read(CONTRACTS_DIR), ...read(CORE_DIR)]) {
      for (const token of VENDOR_TOKENS) {
        expect(source, `${file} must not reference vendor token ${token}`).not.toContain(token)
      }
    }
  })

  it('has no tool-execution path in the adapter', () => {
    for (const { file, source } of read(ADAPTER_DIR)) {
      expect(source, `${file} must not reference a tool gateway`).not.toMatch(/ToolGateway/)
      expect(source, `${file} must not execute a tool`).not.toMatch(/gateway\.invoke/)
      expect(source, `${file} must not execute a tool`).not.toMatch(/executeTool/)
      expect(source, `${file} must not call tool\.execute`).not.toMatch(/tool\.execute/)
    }
  })

  it('exposes the adapter as a GenerationPort', () => {
    expect(typeof CompanyGenerationAdapter).toBe('function')
    const port = new CompanyGenerationAdapter({
      baseUrl: 'http://127.0.0.1:1',
      secretRef: 'ref',
      models: {},
      secrets: { resolve: () => Promise.reject(new Error('unused')) },
      budget: {
        openLedger: () => Promise.reject(new Error('unused')),
        reserve: () => Promise.reject(new Error('unused')),
        recordIntent: () => Promise.reject(new Error('unused')),
        settle: () => Promise.reject(new Error('unused')),
        remaining: () => Promise.reject(new Error('unused')),
      },
      ledgerId: '00000000-0000-4000-8000-000000000000',
      evidence: { record: () => Promise.reject(new Error('unused')) },
    })
    const asPort: GenerationPort = port
    expect(typeof asPort.generate).toBe('function')
  })
})
