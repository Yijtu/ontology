# LOCAL-054 跨层端到端验收与本地交付报告

> 本报告由 `tests/e2e/acceptance/delivery-report.ts` 生成，`delivery-report.spec.ts` 校验其结构。
> 本地 E2E 成功**不等于** LOCAL-051/052/053 完成；未实测项见末尾。

## 1. 环境

- Node: v24.18.0
- pnpm: 11.17.0
- Docker: Docker Desktop, throwaway postgres:17 container per run
- PostgreSQL: postgres:17 (fallback 16-alpine / 16)
- Browser: Playwright Chromium (headless)
- Hardware: win32/x64, Intel(R) Core(TM) 5 210H, 12 logical CPUs, 32507 MiB RAM

## 2. 复现命令

```text
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:acceptance
pnpm run build:web && pnpm run test:e2e
```

## 3. 数据规模

- 文档：1 份；抽取候选：3 个；遥测行：6 行；驱动 run：3 次；每个 run 证据：2 条；语义 statement：1 条

## 4. 验收条件

- [x] A1 自动完成「配置 → 接入/预处理 → 候选/裁决/发布 → 提问 → 工具 → 草稿核验 → 答案 → 来源」，断言 UI/API/job/data 真实路径
  - 证据：tests/e2e/acceptance/cross-layer.acceptance.spec.ts — real Fastify API + real PostgreSQL stores + real blob + real worker + real workflow controller; UI path in acceptance.browser.e2e.ts
- [x] A2 覆盖依据撤回、历史回放、澄清/权限/超时至少一条失败路径；覆盖无本体、第二映射、两 runtime 与 local/MCP
  - 证据：cross-layer.acceptance.spec.ts (retraction, history replay), failure-paths.acceptance.spec.ts (clarification, permission, deadline), matrix.acceptance.spec.ts (both runtimes, no-ontology direct vs second mapping; local/stdio-MCP reused from LOCAL-049 X-02)
- [x] A3 CI 使用确定模型响应和独立临时数据；浏览器验证；报告明确模型与硬件尚未实测部分
  - 证据：Deterministic generation/decision doubles (no paid call); a throwaway PostgreSQL container + a per-run temp object dir; acceptance.browser.e2e.ts; NOT_VERIFIED below
- [x] A4 不能因真实模型/HA 未就绪阻塞本地 E2E，也不能把本地 E2E 结果当成 LOCAL-051—053 完成
  - 证据：The suite runs with no real model/HA; LOCAL-051/052/053 are listed as not complete below
- [x] A5 完成浏览器验证，保存关键正常/异常交互的可复现证据
  - 证据：tests/e2e/acceptance/acceptance.browser.e2e.ts writes PNG/log evidence into the gitignored tests/e2e/artifacts/

## 5. 替换矩阵覆盖（V2 X-01—X-08）

- X-01 Pi ↔ Template runtime — composition/x01-runtime-conformance.spec.ts + matrix.acceptance.spec.ts
- X-02 local ↔ stdio MCP transport — composition/x02-x03-transport-backend-conformance.spec.ts (reused, not duplicated)
- X-03 DuckDB ↔ PostgreSQL backend — composition/x02-x03-transport-backend-conformance.spec.ts
- X-04 home-energy ↔ no-industry direct — composition/x04-x06-industry-mapping-swap.spec.ts + matrix.acceptance.spec.ts
- X-05 model ↔ controlled stub — composition/x05-model-conformance.spec.ts
- X-06 mapping A ↔ mapping B — composition/x04-x06-industry-mapping-swap.spec.ts + matrix.acceptance.spec.ts (MAPPING_C)
- X-07 profile v1 ↔ v2 — composition/x07-profile-version-conformance.spec.ts
- X-08 incompatible capabilities — composition/x08-unsupported-conformance.spec.ts

## 6. 失败路径

- 依据撤回 (evidence retraction) — cross-layer.acceptance.spec.ts — statement retraction, history preserved, proposition withdrawn
- 历史回放 (history replay) — cross-layer.acceptance.spec.ts — GET /objects/{id}/history?recordedAt=<v1>
- 澄清 (clarification) — failure-paths.acceptance.spec.ts — real run service respond-to-clarification
- 权限 (permission) — failure-paths.acceptance.spec.ts — role denial + cross-tenant evidence 404
- 超时 (timeout) — failure-paths.acceptance.spec.ts — real gateway DEADLINE_EXCEEDED via raceWithAbort

## 7. 未实测 / 外部条件（不得记为完成）

- **model-company-endpoint**：no authorized real company generation endpoint/quota; CI uses a deterministic double
- **model-jev-endpoint**：no authorized real JEV endpoint/quota; CI uses a deterministic double
- **data-ha**：no live Home Assistant driver; simulation is the default (SPEC §11, E7)
- **live-device-actions**：no device request is ever sent; live execution is out of scope and blocked by design
- **blob-s3**：S3 blob is not deployed; blob-local is the real first-phase backend
- **search-vector / search-milvus**：vector/hybrid retrieval is not implemented; keyword BM25 is the real path
- **data-starrocks / data-iceberg**：not-ready plugins, not first-phase deployments
- **transport-mcp-http**：remote/Streamable HTTP MCP is defined but not enabled
- **LOCAL-051 (live-model-validation)**：real model quality/calibration NOT evaluated; local E2E does not complete it
- **LOCAL-052 (ha-read-integration)**：live Home Assistant read NOT integrated; local E2E does not complete it
- **LOCAL-053 (live-device-actions)**：live device actions NOT executed; local E2E does not complete it

## 8. 结论

本地跨层验收全部通过；真实模型质量、JEV 校准、HA 实机读取与设备执行仍未验证，
LOCAL-051/052/053 保持未完成状态。
