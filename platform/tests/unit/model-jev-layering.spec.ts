import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { JevDecisionAdapter } from '@ontology/adapter-model-jev'
import type { DecisionPort, GenerationPort } from '@ontology/contracts'

const ADAPTER_DIR = fileURLToPath(new URL('../../packages/adapters/model-jev/src', import.meta.url))
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
const VENDOR_TOKENS = ['JevWire', 'jev-wire', 'option_set_hash', 'question_id', 'selected_option_id', 'model_version']

describe('model-jev adapter layering (SPEC §2, §4.2, ADR-09)', () => {
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
    expect(index).not.toMatch(/JevWire/)
    for (const { file, source } of read(ADAPTER_DIR)) {
      if (file.endsWith('index.ts')) continue
      if (file.includes(`${join('src', 'vendor')}`)) continue
      expect(source, `${file} must not re-export a vendor type`).not.toMatch(/export .*JevWire/)
    }
  })

  it('does not reference any vendor identifier from contracts or core', () => {
    for (const { file, source } of [...read(CONTRACTS_DIR), ...read(CORE_DIR)]) {
      for (const token of VENDOR_TOKENS) {
        expect(source, `${file} must not reference vendor token ${token}`).not.toContain(token)
      }
    }
  })

  it('implements DecisionPort and exposes no GenerationPort surface', () => {
    const adapter = new JevDecisionAdapter({
      baseUrl: 'http://127.0.0.1:1',
      secretRef: 'ref',
      models: {},
      stateResolver: { resolve: () => Promise.reject(new Error('unused')) },
      fallbackPolicy: 'clarify',
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
    const asPort: DecisionPort = adapter
    expect(typeof asPort.decide).toBe('function')
    expect('generate' in adapter).toBe(false)
    expectTypeOf<GenerationPort>().not.toEqualTypeOf<DecisionPort>()
  })

  it('has no chat-completion or generation shape in the adapter', () => {
    for (const { file, source } of read(ADAPTER_DIR)) {
      expect(source, `${file} must not handle chat messages`).not.toMatch(/GenerationMessage|GenerationRequest/)
      expect(source, `${file} must not handle tool schemas`).not.toMatch(/toolSchemas|tool_call|ToolGateway/)
      expect(source, `${file} must not stream generated text`).not.toMatch(/text_delta|AsyncGenerator/)
    }
  })
})
