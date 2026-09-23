# 本地 POC Core：注册任务产品切片

仓库提供可启动的本地工作台和 API。当前 local deployment 注册家庭能源、交通设施与文档引用任务，验证正式 HTTP → controller → task runtime → gateway → 来源 handler → 证据归档 → typed hard verification → Postgres 答案发布链路。能源与交通数据是合成 fixture；文档由 operator 提供。

它不是已经接好真实客户数据的通用行业产品。页面 profile 包含两个家庭能源物理布局（宽表 SOC 与长表 metric-code SOC）、一个交通设施表和一个文档集合。前两种结构经各自已注册 mapping 对同一 SOC 问题给出相同口径；交通查询由注册 semantic mapping 编译到只读 DuckDB。长表经显式、可溯源预处理为规范只读视图。不会调用付费模型、JEV、Home Assistant 或真实设备。

页面支持站点 SOC、家庭储能候选计划、按区域筛选待巡检设施、以及在 operator 导入文档中查找原文。非数字断言以 `VerifiedAssertion` 表示并绑定到证据结果 digest 与 JSON pointer；文档引文还校验文档引用、byte-offset locator 和原文 digest。未接通的断言类型会被硬拒绝。能源计划输出有限策略集合中最好的已测试候选，不承诺全局最优。当前文档集合首波只允许一份受控文档；第二份不同文档会明确拒绝，避免静默覆盖旧索引。多实体规则绑定、其他客户 schema、任意 Text2SQL、真实模型和多实例并发恢复均未交付。

## 启动

需要 Node.js 22+、pnpm 10+ 和 Docker。以下 PowerShell 命令在 `platform/` 目录运行：

```powershell
$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml up -d --wait
$env:CONTROL_DATABASE_URL = 'postgresql://postgres:local-only-change-this@127.0.0.1:54329/ontology'
$env:ONTOLOGY_APP_PASSWORD = 'local-app-only-change-this'
pnpm run prepare:local
$env:ONTOLOGY_LOCAL_OPERATOR_TOKEN = 'local-operator-only-change-this'
pnpm run dev:local
```

`prepare:local` 用本机 PostgreSQL owner 凭据应用 control migrations、创建本地 tenant/space 与非 owner `ontology_app` 登录角色，并在 `platform/.env.local` 写入 gitignored 应用连接配置。产品 API 只使用 `ontology_app` 连接。不要把 `.env.local` 分享或提交。

首次建库时 PostgreSQL 会短暂重启。使用 `--wait` 等待容器健康；准备脚本也会最多等待 30 秒，确认宿主机 TCP 连接可用后再迁移。如果此前 `prepare:local` 失败，等容器健康后直接重跑即可，不要为了重试删除数据卷。

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。首页是业务问答。选择 profile 和任务，再按 task descriptor 显示的字段输入条件。能源计划示例：

> 明天如何安排充放电，在满足备电约束下尽量降低电费？

SOC 查询示例：

> synthetic-home-1 的 SOC 均值是多少？

API 默认监听 `127.0.0.1:3000`。停止工作台进程会同时停止 API；Postgres 与内容 blob 保留。再次执行 `pnpm run dev:local` 后，可从原 run ID 读取同一个已发布答案。

已发布的能源计划可通过 `GET /api/v1/runs/{runId}/plan` 读取归档明细；只有 SOC 答案或失败运行返回 404。该只读接口先核对发布答案及其计算证据，再校验归档结果完整性，不会触发新的计算或设备动作。

交通任务示例：

> north 区有哪些设施待巡检？

文档 profile 检索 operator 导入内容，不内置政策句子。可在 API 启动前设置 operator bearer token；请求 body 不能声明角色：

```powershell
$env:ONTOLOGY_LOCAL_OPERATOR_TOKEN = '本机随机长令牌'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/v1/operator/documents `
  -Headers @{ Authorization = "Bearer $env:ONTOLOGY_LOCAL_OPERATOR_TOKEN" } `
  -ContentType 'application/json' -Body (@{ title = '受控文档'; mediaType = 'text/markdown'; content = '# 巡检说明' + "`n" + '北区设施每年巡检两次。' } | ConvertTo-Json -Depth 5)
```

没有 token 的 loopback business 用户收到 403。导入后，选择 `local-policy-documents` profile 与“从已导入文档定位原文”任务，再询问文档内容。答案只引用检索后精确读回的原文 span；无匹配来源时运行失败。首波每个 collection 只允许一份文档，第二份不同文档会明确拒绝，避免静默替换活动索引。

停止 PostgreSQL 可运行：

```powershell
docker compose -f deploy/local/docker-compose.yml stop
```

## 验证

```powershell
pnpm run typecheck
pnpm run build:web
pnpm exec vitest run --project unit tests/unit/synthetic-telemetry-profile.spec.ts tests/composition/local-structured-profiles.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/local-product.browser.e2e.ts
```

本地 browser E2E 使用新建的 throwaway PostgreSQL、Chromium 和正式网络 HTTP 路由；它不导入 acceptance harness，也不插入预制答案。测试覆盖计划轨迹与 API 重启读回、SOC-only、unsupported 问题、无数据站点、无文档来源、operator 403/授权导入、交通 typed assertion、文档 exact quote 与跨 profile task 注入拒绝。文档答案也在 API 重启后按同 run 读回。

本地工作流清单与核验记录已持久化，但更新目前没有跨进程版本 CAS。该配置按**单个 API 实例**使用；不要把它作为多副本并发部署证明。
