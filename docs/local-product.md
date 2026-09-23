# 本地 POC Core：家庭能源切片

仓库现在提供一个可启动的本地工作台和 API。它是**合成数据上的家庭能源切片**，用于实际验证 HTTP → controller → DuckDB/计算 handler → 证据归档 → 硬核验 → Postgres 答案发布这条产品路径。

它不是已经接好真实客户数据的通用行业产品。页面目前支持两个本地 profile：宽表 SOC 与长表 metric-code SOC。长表先按显式预处理转换成只读规范视图，再用同一个 `battery_soc_reading` 语义查询；两种布局使用合成记录，不能代表客户现场验收。家庭能源计算读取合成负荷、光伏、电价、电池与备电参数。不会调用付费模型、JEV、Home Assistant 或真实设备。

页面支持查询指定站点的平均 SOC，以及运行一个家庭储能候选计划。候选计划回答会显示经核验的平均 SOC、候选与无电池基线费用、计划末端储能量和备电约束结果。展开“候选充放电计划”可查看所选策略、96 个时段的充/放电功率和储能量轨迹、备电余量检查与归档来源。明细从完整性校验通过的仿真结果读取，并要求费用、末端能量和备电状态与已发布的核验摘要一致；逐时段明细本身尚未逐项作 claim 核验。结果是有限策略集合中最好的已测试候选，不承诺全局最优。多实体规则绑定、其他行业、任意 Text2SQL/客户 schema 上传、真实模型和多实例并发恢复均未交付。范围以本文件为准，不要把任务卡数量或局部测试误读为这些能力已完成。

## 启动

需要 Node.js 22+、pnpm 10+ 和 Docker。以下 PowerShell 命令在 `platform/` 目录运行：

```powershell
$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml up -d --wait
$env:CONTROL_DATABASE_URL = 'postgresql://postgres:local-only-change-this@127.0.0.1:54329/ontology'
$env:ONTOLOGY_APP_PASSWORD = 'local-app-only-change-this'
pnpm run prepare:local
pnpm run dev:local
```

`prepare:local` 用本机 PostgreSQL owner 凭据应用 control migrations、创建本地 tenant/space 与非 owner `ontology_app` 登录角色，并在 `platform/.env.local` 写入 gitignored 应用连接配置。产品 API 只使用 `ontology_app` 连接。不要把 `.env.local` 分享或提交。

首次建库时 PostgreSQL 会短暂重启。使用 `--wait` 等待容器健康；准备脚本也会最多等待 30 秒，确认宿主机 TCP 连接可用后再迁移。如果此前 `prepare:local` 失败，等容器健康后直接重跑即可，不要为了重试删除数据卷。

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。首页是业务问答。选择 A 宽表或 B 长表 profile，输入站点（默认 `synthetic-home-1`）、备电保留量、天气和问题。示例：

> 明天如何安排充放电，在满足备电约束下尽量降低电费？

SOC 查询示例：

> synthetic-home-1 的 SOC 均值是多少？

API 默认监听 `127.0.0.1:3000`。停止工作台进程会同时停止 API；Postgres 与内容 blob 保留。再次执行 `pnpm run dev:local` 后，可从原 run ID 读取同一个已发布答案。

已发布的能源计划可通过 `GET /api/v1/runs/{runId}/plan` 读取归档明细；只有 SOC 答案或失败运行返回 404。该只读接口先核对发布答案及其计算证据，再校验归档结果完整性，不会触发新的计算或设备动作。

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

本地 browser E2E 使用新建的 throwaway PostgreSQL、Chromium 和正式网络 HTTP 路由；它不导入 acceptance harness，也不插入预制答案。测试会从页面提交 run，等待该 run 产生答案并展示 96 段计划轨迹，关闭并重启 API，再读取相同的答案 ID/hash 和计划结果文件；还检查 SOC-only、unsupported 问题与无数据站点不会得到普通答案。

本地工作流清单与核验记录已持久化，但更新目前没有跨进程版本 CAS。该配置按**单个 API 实例**使用；不要把它作为多副本并发部署证明。
