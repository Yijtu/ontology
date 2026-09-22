import { hardwareInfo } from '../../load/metrics'
import type { HardwareInfo } from '../../load/metrics'

/**
 * LOCAL-054 delivery report (SPEC V3 US-025, V5, FR-34).
 *
 * This module is the single structured source for the delivery report. It states exactly
 * which acceptance criteria passed and which parts remain externally unverified, so a local
 * end-to-end success can never be mistaken for LOCAL-051/052/053 completion. The Markdown is
 * generated from this structure by `delivery-report.spec.ts`.
 */

export interface CriterionResult {
  readonly id: string
  readonly description: string
  readonly status: 'pass' | 'fail'
  readonly evidence: string
}

export const ACCEPTANCE_CRITERIA: readonly CriterionResult[] = [
  {
    id: 'A1',
    description:
      '自动完成「配置 → 接入/预处理 → 候选/裁决/发布 → 提问 → 工具 → 草稿核验 → 答案 → 来源」，断言 UI/API/job/data 真实路径',
    status: 'pass',
    evidence:
      'tests/e2e/acceptance/cross-layer.acceptance.spec.ts — real Fastify API + real PostgreSQL stores + real blob + real worker + real workflow controller; UI path in acceptance.browser.e2e.ts',
  },
  {
    id: 'A2',
    description:
      '覆盖依据撤回、历史回放、澄清/权限/超时至少一条失败路径；覆盖无本体、第二映射、两 runtime 与 local/MCP',
    status: 'pass',
    evidence:
      'cross-layer.acceptance.spec.ts (retraction, history replay), failure-paths.acceptance.spec.ts (clarification, permission, deadline), matrix.acceptance.spec.ts (both runtimes, no-ontology direct vs second mapping; local/stdio-MCP reused from LOCAL-049 X-02)',
  },
  {
    id: 'A3',
    description: 'CI 使用确定模型响应和独立临时数据；浏览器验证；报告明确模型与硬件尚未实测部分',
    status: 'pass',
    evidence:
      'Deterministic generation/decision doubles (no paid call); a throwaway PostgreSQL container + a per-run temp object dir; acceptance.browser.e2e.ts; NOT_VERIFIED below',
  },
  {
    id: 'A4',
    description:
      '不能因真实模型/HA 未就绪阻塞本地 E2E，也不能把本地 E2E 结果当成 LOCAL-051—053 完成',
    status: 'pass',
    evidence:
      'The suite runs with no real model/HA; LOCAL-051/052/053 are listed as not complete below',
  },
  {
    id: 'A5',
    description: '完成浏览器验证，保存关键正常/异常交互的可复现证据',
    status: 'pass',
    evidence:
      'tests/e2e/acceptance/acceptance.browser.e2e.ts writes PNG/log evidence into the gitignored tests/e2e/artifacts/',
  },
]

export interface MatrixEntry {
  readonly item: string
  readonly coveredBy: string
}

/** Each replaceability-matrix item mapped to the real test that exercises it. */
export const MATRIX_COVERAGE: readonly MatrixEntry[] = [
  { item: 'X-01 Pi ↔ Template runtime', coveredBy: 'composition/x01-runtime-conformance.spec.ts + matrix.acceptance.spec.ts' },
  { item: 'X-02 local ↔ stdio MCP transport', coveredBy: 'composition/x02-x03-transport-backend-conformance.spec.ts (reused, not duplicated)' },
  { item: 'X-03 DuckDB ↔ PostgreSQL backend', coveredBy: 'composition/x02-x03-transport-backend-conformance.spec.ts' },
  { item: 'X-04 home-energy ↔ no-industry direct', coveredBy: 'composition/x04-x06-industry-mapping-swap.spec.ts + matrix.acceptance.spec.ts' },
  { item: 'X-05 model ↔ controlled stub', coveredBy: 'composition/x05-model-conformance.spec.ts' },
  { item: 'X-06 mapping A ↔ mapping B', coveredBy: 'composition/x04-x06-industry-mapping-swap.spec.ts + matrix.acceptance.spec.ts (MAPPING_C)' },
  { item: 'X-07 profile v1 ↔ v2', coveredBy: 'composition/x07-profile-version-conformance.spec.ts' },
  { item: 'X-08 incompatible capabilities', coveredBy: 'composition/x08-unsupported-conformance.spec.ts' },
]

export interface FailurePathEntry {
  readonly path: string
  readonly coveredBy: string
}

export const FAILURE_PATHS: readonly FailurePathEntry[] = [
  { path: '依据撤回 (evidence retraction)', coveredBy: 'cross-layer.acceptance.spec.ts — statement retraction, history preserved, proposition withdrawn' },
  { path: '历史回放 (history replay)', coveredBy: 'cross-layer.acceptance.spec.ts — GET /objects/{id}/history?recordedAt=<v1>' },
  { path: '澄清 (clarification)', coveredBy: 'failure-paths.acceptance.spec.ts — real run service respond-to-clarification' },
  { path: '权限 (permission)', coveredBy: 'failure-paths.acceptance.spec.ts — role denial + cross-tenant evidence 404' },
  { path: '超时 (timeout)', coveredBy: 'failure-paths.acceptance.spec.ts — real gateway DEADLINE_EXCEEDED via raceWithAbort' },
]

export interface NotVerifiedEntry {
  readonly id: string
  readonly reason: string
}

/**
 * The parts that are NOT exercised by this local acceptance. The first group is the SPEC §11
 * open items; the second group is the external-condition tasks that must not be reported as
 * complete on the strength of a local E2E.
 */
export const NOT_VERIFIED: readonly NotVerifiedEntry[] = [
  { id: 'model-company-endpoint', reason: 'no authorized real company generation endpoint/quota; CI uses a deterministic double' },
  { id: 'model-jev-endpoint', reason: 'no authorized real JEV endpoint/quota; CI uses a deterministic double' },
  { id: 'data-ha', reason: 'no live Home Assistant driver; simulation is the default (SPEC §11, E7)' },
  { id: 'live-device-actions', reason: 'no device request is ever sent; live execution is out of scope and blocked by design' },
  { id: 'blob-s3', reason: 'S3 blob is not deployed; blob-local is the real first-phase backend' },
  { id: 'search-vector / search-milvus', reason: 'vector/hybrid retrieval is not implemented; keyword BM25 is the real path' },
  { id: 'data-starrocks / data-iceberg', reason: 'not-ready plugins, not first-phase deployments' },
  { id: 'transport-mcp-http', reason: 'remote/Streamable HTTP MCP is defined but not enabled' },
  { id: 'LOCAL-051 (live-model-validation)', reason: 'real model quality/calibration NOT evaluated; local E2E does not complete it' },
  { id: 'LOCAL-052 (ha-read-integration)', reason: 'live Home Assistant read NOT integrated; local E2E does not complete it' },
  { id: 'LOCAL-053 (live-device-actions)', reason: 'live device actions NOT executed; local E2E does not complete it' },
]

export interface DataScale {
  readonly documentsIngested: number
  readonly extractionCandidates: number
  readonly telemetryRows: number
  readonly runsDriven: number
  readonly evidenceRecordsPerRun: number
  readonly semanticStatements: number
}

export const DATA_SCALE: DataScale = {
  documentsIngested: 1,
  extractionCandidates: 3,
  telemetryRows: 6,
  runsDriven: 3,
  evidenceRecordsPerRun: 2,
  semanticStatements: 1,
}

export interface EnvironmentReport {
  readonly node: string
  readonly pnpm: string
  readonly docker: string
  readonly postgres: string
  readonly browser: string
  readonly hardware: HardwareInfo
}

export const COMMANDS: readonly string[] = [
  'pnpm install --frozen-lockfile',
  'pnpm run verify',
  'pnpm run test:acceptance',
  'pnpm run build:web && pnpm run test:e2e',
]

export function buildEnvironmentReport(): EnvironmentReport {
  return {
    node: process.version,
    pnpm: '11.17.0',
    docker: 'Docker Desktop, throwaway postgres:17 container per run',
    postgres: 'postgres:17 (fallback 16-alpine / 16)',
    browser: 'Playwright Chromium (headless)',
    hardware: hardwareInfo(),
  }
}

export function buildDeliveryReport(): string {
  const environment = buildEnvironmentReport()
  const lines: string[] = []
  lines.push('# LOCAL-054 跨层端到端验收与本地交付报告')
  lines.push('')
  lines.push('> 本报告由 `tests/e2e/acceptance/delivery-report.ts` 生成，`delivery-report.spec.ts` 校验其结构。')
  lines.push('> 本地 E2E 成功**不等于** LOCAL-051/052/053 完成；未实测项见末尾。')
  lines.push('')
  lines.push('## 1. 环境')
  lines.push('')
  lines.push(`- Node: ${environment.node}`)
  lines.push(`- pnpm: ${environment.pnpm}`)
  lines.push(`- Docker: ${environment.docker}`)
  lines.push(`- PostgreSQL: ${environment.postgres}`)
  lines.push(`- Browser: ${environment.browser}`)
  lines.push(
    `- Hardware: ${environment.hardware.platform}/${environment.hardware.arch}, ${environment.hardware.cpuModel}, ` +
      `${String(environment.hardware.logicalCpus)} logical CPUs, ${String(environment.hardware.totalMemoryMiB)} MiB RAM`,
  )
  lines.push('')
  lines.push('## 2. 复现命令')
  lines.push('')
  lines.push('```text')
  for (const command of COMMANDS) lines.push(command)
  lines.push('```')
  lines.push('')
  lines.push('## 3. 数据规模')
  lines.push('')
  lines.push(
    `- 文档：${String(DATA_SCALE.documentsIngested)} 份；抽取候选：${String(DATA_SCALE.extractionCandidates)} 个；` +
      `遥测行：${String(DATA_SCALE.telemetryRows)} 行；驱动 run：${String(DATA_SCALE.runsDriven)} 次；` +
      `每个 run 证据：${String(DATA_SCALE.evidenceRecordsPerRun)} 条；语义 statement：${String(DATA_SCALE.semanticStatements)} 条`,
  )
  lines.push('')
  lines.push('## 4. 验收条件')
  lines.push('')
  for (const criterion of ACCEPTANCE_CRITERIA) {
    lines.push(`- [${criterion.status === 'pass' ? 'x' : ' '}] ${criterion.id} ${criterion.description}`)
    lines.push(`  - 证据：${criterion.evidence}`)
  }
  lines.push('')
  lines.push('## 5. 替换矩阵覆盖（V2 X-01—X-08）')
  lines.push('')
  for (const entry of MATRIX_COVERAGE) lines.push(`- ${entry.item} — ${entry.coveredBy}`)
  lines.push('')
  lines.push('## 6. 失败路径')
  lines.push('')
  for (const entry of FAILURE_PATHS) lines.push(`- ${entry.path} — ${entry.coveredBy}`)
  lines.push('')
  lines.push('## 7. 未实测 / 外部条件（不得记为完成）')
  lines.push('')
  for (const entry of NOT_VERIFIED) lines.push(`- **${entry.id}**：${entry.reason}`)
  lines.push('')
  lines.push('## 8. 结论')
  lines.push('')
  lines.push('本地跨层验收全部通过；真实模型质量、JEV 校准、HA 实机读取与设备执行仍未验证，')
  lines.push('LOCAL-051/052/053 保持未完成状态。')
  lines.push('')
  return lines.join('\n')
}
