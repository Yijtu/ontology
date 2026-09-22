import { describe, expect, it } from 'vitest'
import {
  ALLOWED_FORMATTING_DIFFERENCES,
  CONFIGURED_MODULES,
  NOT_CONFIGURED_MODULES,
  X_CASE_REPORT,
  assertNoModuleReportedAsPassed,
  configurationStateOf,
  notConfiguredModules,
} from './not-configured'

/**
 * The conformance report itself is part of the deliverable: it must show which X-cases are
 * exercised with real adapters and which external modules remain explicitly `not_configured`.
 * The assertions here make "not configured" a first-class, testable outcome rather than an
 * implicit gap.
 */

const EXTERNAL_UNVERIFIED = [
  'data-ha',
  'blob-s3',
  'search-vector',
  'data-starrocks',
  'data-iceberg',
  'search-milvus',
  'model-company-endpoint',
  'model-jev-endpoint',
  'transport-mcp-http',
] as const

describe('conformance report', () => {
  it('exercises every X-case in the V2 replaceability matrix', () => {
    expect(X_CASE_REPORT.map((entry) => entry.caseId)).toEqual([
      'X-01',
      'X-02',
      'X-03',
      'X-04',
      'X-05',
      'X-06',
      'X-07',
      'X-08',
    ])
    for (const entry of X_CASE_REPORT) {
      expect(entry.state, entry.caseId).toBe('configured')
      expect(entry.summary.length, entry.caseId).toBeGreaterThan(0)
      expect(entry.reason.length, entry.caseId).toBeGreaterThan(0)
    }
  })

  it('reports every externally unverified module as not_configured, never as passed', () => {
    expect(NOT_CONFIGURED_MODULES.every((module) => module.state === 'not_configured')).toBe(true)
    for (const moduleId of EXTERNAL_UNVERIFIED) {
      expect(configurationStateOf(moduleId), moduleId).toBe('not_configured')
    }
    expect(() => assertNoModuleReportedAsPassed(EXTERNAL_UNVERIFIED)).not.toThrow()
    expect(notConfiguredModules().map((module) => module.moduleId).sort()).toEqual(
      [...EXTERNAL_UNVERIFIED].sort(),
    )
  })

  it('declares the first-phase real modules as configured', () => {
    expect(CONFIGURED_MODULES.every((module) => module.state === 'configured')).toBe(true)
    const configuredIds = CONFIGURED_MODULES.map((module) => module.moduleId)
    expect(configuredIds).toContain('runtime-pi')
    expect(configuredIds).toContain('runtime-template')
    expect(configuredIds).toContain('data-postgres')
    expect(configuredIds).toContain('data-duckdb')
    expect(configuredIds).toContain('transport-local')
    expect(configuredIds).toContain('transport-mcp-stdio')
  })

  it('documents the allowed backend-irrelevant formatting differences', () => {
    expect(ALLOWED_FORMATTING_DIFFERENCES.length).toBeGreaterThan(0)
    const text = ALLOWED_FORMATTING_DIFFERENCES.join(' ')
    expect(text).toContain('callId')
    expect(text).toContain('readAt')
    expect(text).toContain('dialect')
  })

  it('rejects an unknown module id instead of silently defaulting', () => {
    expect(() => configurationStateOf('not-a-real-module')).toThrowError(/unknown module/)
  })
})
