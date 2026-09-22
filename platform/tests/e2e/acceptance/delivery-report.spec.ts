import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_CRITERIA,
  COMMANDS,
  DATA_SCALE,
  FAILURE_PATHS,
  MATRIX_COVERAGE,
  NOT_VERIFIED,
  buildDeliveryReport,
  buildEnvironmentReport,
} from './delivery-report'

/**
 * The delivery report is part of the deliverable, so its structure is asserted here: every
 * acceptance criterion is marked, the matrix and failure paths are mapped to real tests, and
 * the externally unverified items (including LOCAL-051/052/053) are present. A local E2E can
 * therefore never be reported as real-model/HA completion.
 */

describe('LOCAL-054 delivery report', () => {
  it('marks every acceptance criterion as passed', () => {
    expect(ACCEPTANCE_CRITERIA).toHaveLength(5)
    expect(ACCEPTANCE_CRITERIA.every((criterion) => criterion.status === 'pass')).toBe(true)
    for (const criterion of ACCEPTANCE_CRITERIA) {
      expect(criterion.evidence.length).toBeGreaterThan(0)
    }
  })

  it('maps every replaceability-matrix case to a real test', () => {
    expect(MATRIX_COVERAGE.length).toBe(8)
    for (const entry of MATRIX_COVERAGE) {
      expect(entry.coveredBy.length).toBeGreaterThan(0)
    }
  })

  it('covers all five required failure paths', () => {
    expect(FAILURE_PATHS.map((entry) => entry.path)).toEqual([
      '依据撤回 (evidence retraction)',
      '历史回放 (history replay)',
      '澄清 (clarification)',
      '权限 (permission)',
      '超时 (timeout)',
    ])
  })

  it('lists the external-condition items and never claims LOCAL-051/052/053', () => {
    const ids = NOT_VERIFIED.map((entry) => entry.id)
    expect(ids).toContain('model-company-endpoint')
    expect(ids).toContain('model-jev-endpoint')
    expect(ids).toContain('data-ha')
    expect(ids).toContain('live-device-actions')
    expect(ids.some((id) => id.includes('LOCAL-051'))).toBe(true)
    expect(ids.some((id) => id.includes('LOCAL-052'))).toBe(true)
    expect(ids.some((id) => id.includes('LOCAL-053'))).toBe(true)
  })

  it('records the environment and the reproducible commands', () => {
    const environment = buildEnvironmentReport()
    expect(environment.node.length).toBeGreaterThan(0)
    expect(environment.hardware.logicalCpus).toBeGreaterThan(0)
    expect(COMMANDS).toContain('pnpm run verify')
    expect(COMMANDS).toContain('pnpm run test:acceptance')
    expect(DATA_SCALE.documentsIngested).toBeGreaterThan(0)
  })

  it('renders a Markdown report containing every section', () => {
    const markdown = buildDeliveryReport()
    expect(markdown).toContain('# LOCAL-054')
    expect(markdown).toContain('## 4. 验收条件')
    expect(markdown).toContain('## 7. 未实测 / 外部条件')
    expect(markdown).toContain('LOCAL-051')
    expect(markdown).toContain('LOCAL-052')
    expect(markdown).toContain('LOCAL-053')
    expect(markdown).toContain('pnpm run verify')
    for (const criterion of ACCEPTANCE_CRITERIA) expect(markdown).toContain(criterion.id)
  })
})
