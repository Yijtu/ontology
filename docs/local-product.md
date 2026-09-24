# 本地 POC Core：注册任务产品切片

仓库提供可启动的本地工作台和 API。当前 local deployment 注册家庭能源、合成交通、operator 文档，以及可选的只读 PostgreSQL 交通视图任务，验证正式 HTTP → controller → task runtime → gateway → 来源 handler → 证据归档 → typed hard verification → Postgres 答案发布链路。能源与默认交通数据是合成 fixture；文档由 operator 提供。

它不是已经接好任意客户数据的通用行业产品。页面 profile 包含两个家庭能源物理布局（宽表 SOC 与长表 metric-code SOC）、合成交通设施表、一个受控文档集合和一个可选 operator SQL 视图。前两种结构经各自已注册 mapping 对同一 SOC 问题给出相同口径；交通问题可在合成 DuckDB 与真实只读 PostgreSQL 视图上执行。SQL 视图仍要求部署时明确列契约和映射，不自动扫描/执行任意客户表。只有 operator 在服务端显式配置公司模型后，候选抽取才会调用生成模型；正式业务问答仍不调用 JEV、Home Assistant 或真实设备。

页面支持站点 SOC、家庭储能候选计划、按区域筛选待巡检设施、以及在 operator 导入文档中查找原文。operator API 额外支持“完整 JSON 实体记录 → 解析/span → 确定性候选 job → SQL 身份召回与审计 → 人工决策/审核 → 语义发布”；服务端可选接入公司模型，将非结构化 span 提为待审候选。非数字断言以 `VerifiedAssertion` 表示并绑定到证据结果 digest 与 JSON pointer；文档引文还校验文档引用、byte-offset locator 和原文 digest。未接通的断言类型会被硬拒绝。能源计划输出有限策略集合中最好的已测试候选，不承诺全局最优。每个文档 collection 当前只允许一份内容；同内容重试复用 parse/index，不同内容（包括已在另一 collection 解析的内容）返回 409。多实体在线规则回答、其他客户 schema 自动识别、任意 Text2SQL、公司模型真实接口验收和多实例并发恢复均未交付。

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

更新到新增迁移（包括身份召回审计表）的版本后，应再次运行 `pnpm run prepare:local` 再启动；不要为更新而删除数据库卷。若需要启用 operator SQL 任务，在执行 `pnpm run dev:local` **之前**于同一个 PowerShell 设置 `ONTOLOGY_OPERATOR_SQL_URL`，指向仅有目标视图 `SELECT` 权限的业务库账号。可选设置 `ONTOLOGY_OPERATOR_SQL_SCHEMA`、`ONTOLOGY_OPERATOR_SQL_RELATION`，默认是 `public.ontology_facilities`。连接串与密码仅存在本地服务端环境中，不由网页/API 请求上传。

首次建库时 PostgreSQL 会短暂重启。使用 `--wait` 等待容器健康；准备脚本也会最多等待 30 秒，确认宿主机 TCP 连接可用后再迁移。如果此前 `prepare:local` 失败，等容器健康后直接重跑即可，不要为了重试删除数据卷。

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。首页是业务问答。选择 profile 和任务，再按 task descriptor 显示的字段输入条件。能源计划示例：

> 明天如何安排充放电，在满足备电约束下尽量降低电费？

SOC 查询示例：

> synthetic-home-1 的 SOC 均值是多少？

API 默认监听 `127.0.0.1:3000`。停止工作台进程会同时停止 API；Postgres 与内容 blob 保留。再次执行 `pnpm run dev:local` 后，可从原 run ID 读取同一个已发布答案。

已发布的能源计划可通过 `GET /api/v1/runs/{runId}/plan` 读取归档明细；只有 SOC 答案或失败运行返回 404。该只读接口先核对发布答案及其计算证据，再校验归档结果完整性，不会触发新的计算或设备动作。

### Anker 家庭能源模拟执行

打开 `http://127.0.0.1:5173/?profileId=home-energy-demo-long&profileVersion=1.0.0&view=energy`。默认 Virtual SOLIX 为 3.5/10 kWh（35% SOC），全天备电下限 20%，上午阴、下午晴。依次点击“构建情景”“生成计划”；页面产生直接计算预览，并为同一输入提交正式 `POST /runs`。只有正式 run 发布核验答案、两条路径的完整 planRef 一致且状态版本相同时，计划才进入 `Selected`。直接预览和旧站点 45% SOC 不能授权执行 35% 场景的计划。

先保持初态不执行，把天气改成“上午阴、下午阴雨”再构建/生成：上午 PV 预测不变，下午下降，B 的计划选中后 A 才 `Superseded`。再把 ReserveSOC 改为 60%，生效窗口选“晚间 17:00 起保底”，得到 C：当前仍是 35%，计划先补电、减少晚间放电，展示成本与备电差异。顶部 Solar/Battery/Grid/HomeLoad 卡片读取归档计划的同一时隙，可拖动滑块查看 96 段；每个数值标出单位、来源、时间与预测/模拟模式，缺可行结果时不展示预置功率。两次变更都来自真实新场景工件和正式 run；新旧计划只能在时窗与初态相同的前提下计算差值。

点击当前 `Selected` 计划的“请求模拟执行”后，Virtual SOLIX 逐步应用 96 个 PlanStep，每步保存 Requested→Accepted→Observed、前后电量与不可变状态引用。页面显示期末 SOC、execution ID 和逐步回执；`GET /api/v1/executions/{executionId}` 在 API 重启后仍可读取。同一幂等键重试复用原记录；改变请求内容、换键重复执行同一 plan、旧版或过期状态均被拒绝。请求 `mode=live` 会在任何设备调用前返回 `CAPABILITY_NOT_CONFIGURED`。执行后的新场景从期末 SOC 和下一模拟时窗开始，跨时窗 diff 返回 `PLAN_DIFF_NOT_COMPARABLE` 并保留两版各自结果。

目前真实 PostgreSQL、不可变 blob 与 Chromium 验收覆盖 A/B/C/E：同状态重规划、旧版替代、状态 CAS、96 步读回、重启和跨日续跑。A4 的 Weather→Solar→Battery 已确认实例关系链尚未绑定到本次预测/计划，页面只显示确定性变化与限制，不能宣称本体因果已验证；D1 中过期预测和异常回执仍需完整注入验收。正式合同见[Anker 场景 SPEC](../tasks/spec-home-energy-anker-v1.0.md)。

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

## 可选：只读 SQL 与候选治理闭环

只读业务账号需能访问一个**符合固定列契约**的表/视图。`registered-operator-sql.ts` 是当前部署契约的权威定义：业务列 `facility_key / district_code / condition_code`，实体与别名列 `entity_id / object_id / identity_scope_id / native_id / display_name / normalized_name / alias / alias_normalized / alias_confirmed`，有效时间/上下文列 `alias_valid_from / alias_valid_to / site / entity_type / valid_from / valid_to / tenant_id / space_id`。启动时会探测列名与类型；任一缺失即拒绝启用该 profile。`data_query` 只允许该已登记对象、受限字段/过滤和只读事务；`tenant_id`、`space_id` 来自可信上下文。若客户结构不同，先建立有来源/版本的只读规范视图或新增部署 mapping，不能让用户问题指定表名、连接串或任意 SQL。

服务启动后，operator 使用同一个本地 bearer token 查询 `GET /api/v1/operator/sql-source`，确认返回 `readOnly: true`、`definitionRef` 和非敏感列摘要。没有 `ONTOLOGY_OPERATOR_SQL_URL` 时该 operator 路由不注册，页面的 SQL profile scope 明确报未配置；普通业务身份没有候选导入/审核权限。下列 PowerShell 示例演示**新实体**路径，业务资料以一条完整 JSON 记录作为精确原文，不声称从任意政策句子自动抽取：

```powershell
$token = 'local-operator-only-change-this'
$base = 'http://127.0.0.1:3000/api/v1'
$auth = @{ Authorization = "Bearer $token" }
$source = Invoke-RestMethod -Uri "$base/operator/sql-source" -Headers $auth
$record = '{"facility_key":"bridge-n-01","facility_name":"Bridge N 01","district":"north","inspection_state":"needs_inspection"}'
$importBody = @{ title = '受控实体记录'; mediaType = 'text/plain'; content = $record } | ConvertTo-Json
$uploaded = Invoke-RestMethod -Method Post -Uri "$base/operator/candidate-documents" -Headers $auth -ContentType 'application/json; charset=utf-8' -Body $importBody
$parseId = $uploaded.data.parseId
$extractHeaders = @{ Authorization = "Bearer $token"; 'Idempotency-Key' = "candidate-$parseId" }
$job = Invoke-RestMethod -Method Post -Uri "$base/operator/documents/$parseId/extract-candidates" -Headers $extractHeaders -ContentType 'application/json' -Body '{}'
$candidateId = $job.data.candidateIds[0]
$candidate = Invoke-RestMethod -Uri "$base/candidates/$candidateId" -Headers $auth
$recall = Invoke-RestMethod -Method Post -Uri "$base/candidates/$candidateId/identity-recall" -Headers $auth -ContentType 'application/json' -Body '{}'
```

此时应先检查 `$candidate.data.candidate.sourceSpans` 和 `$recall.data.result`：召回是**建议及审计**，不是合并事实。若无现成且已确认的实体，人工以 `If-Match: 0` 提交 `create_pending`，得到待确认 entity ID；再按真实候选强键/原文完成 `match`，随后提交候选 `approve` review，最后用 `$source.data.definitionRef` 与当前发布 revision 创建 semantic publication。若选择已有实体，需校验身份范围、native key 和人工理由；冲突或证据不足用 `clarify/reject`，不能强合并。写入端点的完整请求字段和状态见[公开 HTTP 路由](../platform/apps/api/src/http/decisions.ts)与[发布路由](../platform/apps/api/src/http/publication.ts)。发布后在网页切换到 `operator-sql-facilities`，问“north 区有哪些设施待巡检？”，观察只读 SQL 结果的来源证据。**当前该问题按 mapping 查业务视图，不把刚发布的语义事实作为运行时过滤/规则前提**；在线本体推理是后续缺口。可按 job ID、候选 ID、audit ID、publication ID 和 run ID 分别读回；API 重启后这些记录仍在。

当前 `ONTOLOGY_LOCAL_OPERATOR_TOKEN` 仅供 loopback 单租户开发。它让本机 operator 获得数据编辑、语义审核与发布角色；不能作为生产认证或多人审批机制。自动相似度判断仍未配置模型，不会伪造“自动消歧”。

需要试验普通政策文本的实体、关系和规则**候选抽取**时，在启动 API 的服务端环境配置 `ONTOLOGY_COMPANY_MODEL_BASE_URL`、`ONTOLOGY_EXTRACTION_VENDOR_MODEL` 和 `ONTOLOGY_COMPANY_MODEL_API_KEY`；可选 `ONTOLOGY_COMPANY_MODEL_ENDPOINT` 与 `ONTOLOGY_COMPANY_MODEL_PROTOCOL=openai-compatible|private`。API key 只经环境 SecretResolver 读取，不放进请求、Git 或浏览器。配置了其中一个非密钥必填项而缺另一个时启动即拒绝；未配置时沿用上例的纯 JSON 强键映射。公司模型的真实接口兼容性须用该公司的实际网关另行验证，仓库只用受控响应测试了适配器与抽取路径。

模型路径仍先锁定已发布行业 schema，把允许的对象/属性/关系标识传给模型，再对输出做结构、schema、精确来源 span 和人工审核。它不让模型定义新的 schema，也不直接发布事实。同步入口每个 job 最多处理 4 个非结构化 span，超限明确返回 `RESULT_TOO_LARGE`；批量异步抽取尚未交付。每个后台 job 使用独立共享预算，模型适配器负责自己的预留/结算，模型输出摘要写入 `model_output` 证据。`extract-candidates` 返回的 `modelCalls` 是需要生成处理的 span 数，不含网关内部的有界重试次数。

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

本地 browser E2E 使用新建的 throwaway PostgreSQL、Chromium 和正式网络 HTTP 路由；它不导入 acceptance harness，也不插入预制答案。测试覆盖计划轨迹与 API 重启读回、SOC-only、unsupported 问题、无数据站点、无文档来源、operator 403/授权导入、交通 typed assertion、文档 exact quote、跨 profile task 注入拒绝，以及只读业务库、候选 job、身份召回审计、人工决策、语义发布和 SQL 正式 run。文档与 SQL 答案、审核/发布记录在 API 重启后读回。

本地工作流清单与核验记录已持久化，但更新目前没有跨进程版本 CAS。该配置按**单个 API 实例**使用；不要把它作为多副本并发部署证明。
