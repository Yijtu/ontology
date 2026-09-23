# ontology

这是多行业语义与业务 Agent 平台的 TypeScript 仓库。**当前可直接运行的本地 POC 配置包含家庭能源、交通设施和受控文档三类有界任务**：同一个正式 run 会执行注册任务、调用来源工具、归档证据、硬核验并发布答案。演示数据均为合成或 operator 导入内容，不连接真实设备。

## 这个页面究竟能做什么

当前首页是“业务问答”入口，**不是空白后台或开放式聊天窗口**。它把已注册的业务任务跑成可审计的 `run`，目前提供：

| 问题 | 实际执行 | 页面能看到 |
| --- | --- | --- |
| “synthetic-home-1 的 SOC 均值是多少？” | 按所选 profile 将 `battery_soc_reading` 语义查询编译为受限 SQL，在 DuckDB 查询并计算平均值 | 站点、平均 SOC、单位、来源证据和核验状态。静态演示样本为 40% 与 50%，结果为 45%，不是实时设备读数 |
| “明天如何安排充放电，在满足备电约束下尽量降低电费？” | 先查询同一站点 SOC，再用合成负荷、光伏、电价和电池参数测试有限的候选策略 | 估算费用与无电池基线、期末储能量、备电检查；展开后可查看选中策略、96 个 15 分钟时段的充放电和储能量轨迹 |
| “north 区有哪些设施待巡检？” | 按交通 profile 确认的 semantic mapping 查询合成设施 DuckDB 表 | 有类型的设施 ID、区域和待巡检状态断言，各自绑定查询结果指针与来源证据 |
| “已导入文件中的巡检频率原文是什么？” | 在 operator 已导入并索引的文档中检索精确 span | 显示原文引句、byte-offset locator 与文档版本；不将关键词命中扩展成政策结论 |

页面不是开放式聊天机器人。每个 profile 的任务、字段和执行 handler 均由部署注册；选择的任务不支持问题时会明确失败。无来源行、无文档或不完整检索不会变成普通已发布答案。真实客户数据、设备状态和公司模型 API 尚未接入这个本地入口。

一次运行的操作顺序是：选择 profile 与部署任务 → 填写该任务声明的输入 → 提问 → 查看运行进度与共享预算 → 查看已发布答案及证据 → 如果是计划问题，展开归档计划明细。页面显示的 run ID 可以用于再次读取同一次结果。“场景允许范围”展示本次 profile 可调用的工具与 Web 搜索授权，不是操作菜单；当前只开通已注册任务。

## 本地启动（Windows PowerShell）

准备 Node.js 22+、pnpm 11（项目使用 11.17.0）和已启动的 Docker Desktop。首次使用，在仓库根目录打开 PowerShell，执行：

```powershell
cd D:\work\ontology\platform
pnpm install --frozen-lockfile

$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml up -d --wait
$env:CONTROL_DATABASE_URL = 'postgresql://postgres:local-only-change-this@127.0.0.1:54329/ontology'
$env:ONTOLOGY_APP_PASSWORD = 'local-app-only-change-this'
pnpm run prepare:local
$env:ONTOLOGY_LOCAL_OPERATOR_TOKEN = 'local-operator-only-change-this'
pnpm run dev:local
```

上面两处 PostgreSQL 密码必须相同。示例密码只供本机试用；你可以换成自己的值，但要同步修改连接地址。`prepare:local` 会创建表、演示租户和非管理员应用账号，并把应用连接写入已被 Git 忽略的 `platform/.env.local`。不要分享这个文件。

首次建库时 PostgreSQL 会短暂重启。如果 `prepare:local` 报 `Connection terminated unexpectedly`，先运行 `docker compose -f deploy/local/docker-compose.yml up -d --wait`，确认容器健康，再直接重跑 `pnpm run prepare:local`。准备成功前运行 `dev:local` 会因缺少 `.env.local` 报错；无需删除数据库卷。

服务启动后打开 **<http://127.0.0.1:5173/>**。API 地址是 <http://127.0.0.1:3000/>。停止运行时在启动终端按 `Ctrl+C`；数据库和已发布结果会保留。下次使用，在 `platform/` 执行：

```powershell
$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml up -d --wait
pnpm run dev:local
```

如果页面只显示 `HTTP_500`，先看 API 终端的具体异常并确认 `GET http://127.0.0.1:3000/api/v1/runs/scope?profileId=home-energy-demo-wide&version=1.0.0` 是否返回 200。页面初始化失败时可在 API 就绪后刷新；**若提问后仍报 `INTERNAL_ERROR`，刷新不会修复服务端运行错误**，应记录页面显示的 `traceId` 并检查 API 日志。旧版本地代码曾把来源证据引用误作草稿归档引用，导致创建 run 时返回 500；当前实现会先归档完整草稿，再核验和发布。启动脚本会等 API 就绪后再打开页面。

需要停止数据库时，仍在 `platform/` 执行：

```powershell
$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml stop
```

不要用 `down -v` 停止日常环境：它会删除数据库卷和已保存的运行记录。

## 怎么使用

首页按 `/runs/scope` 返回的部署任务描述显示字段。普通业务问答不上传文件，也不自动发现数据库表；受控文档通过单独的 operator API 导入。首次试用按下表逐项选择，不需要自己写 SQL：

| 想验证的能力 | 选择的 profile / 任务 | 输入与预期 |
| --- | --- | --- |
| 同一业务问题适配不同物理表 | `能源 A：宽表遥测` 或 `能源 B：长表 metric-code` / `查询站点 SOC 均值` | 站点 `synthetic-home-1`，问题 `synthetic-home-1 的 SOC 均值是多少？`；两种布局均应得到合成均值 **45%**，并能查看各自来源 |
| 有界领域计算 | 任一能源 profile / `生成储能候选计划` | 站点 `synthetic-home-1`，备电保留量 2 kWh、晴天，问题 `明天如何安排充放电，在满足备电约束下尽量降低电费？`；答案展示候选费用与备电约束，计划面板展示 96 个时段 |
| 跨行业查询 | `交通：设施巡检` / `列出待巡检设施` | 区域 `north`，问题 `north 区有哪些设施待巡检？`；答案返回设施事实与证据指针。询问“巡检周期是多少”不应被误答为设施列表 |
| 文档原文溯源 | `文档：政策引文` / `从已导入文档定位原文` | 先按下方命令导入文档，再问 `已导入文件中的巡检频率原文是什么？`；展示原文、文档版本和定位信息。未导入时会明确失败 |

| 控件 | 当前本地切片的含义 |
| --- | --- |
| profile 和任务 | 下拉项来自部署注册：能源 A/B 结构、交通设施查询、受控文档原文检索。每个任务有自己的字段与支持问题类型；其他问法会被拒绝。 |
| 站点/区域 | 只在声明这些字段的任务上显示；SOC 查询默认 `synthetic-home-1`，交通查询默认 `north`。这些是合成 fixture key。 |
| 计划输入 | 备电保留量（kWh）与天气假设只属于储能候选计划，天气选项是确定性的合成场景。 |
| 文档导入 | 由配置的 operator bearer token 调用专用 API；业务用户不能从请求体伪造 operator 身份。 |
| Web 搜索/模型 | 本地 profile 禁用 web search；受控 runtime 不调用付费模型或 JEV。 |

建议先分别选择 A 和 B，保持站点 `synthetic-home-1`，问同一个 SOC 问题，观察结果口径相同而来源版本不同；再问计划问题，改变备电保留量或天气，比较候选结果。可直接复制：

```text
synthetic-home-1 的 SOC 均值是多少？
明天如何安排充放电，在满足备电约束下尽量降低电费？
```

第一个问题只执行语义查询。第二个问题先查 SOC，再由确定性能源计算测试 `self_consumption`、`reserve_first`、`price_window` 三种候选（实际可行性取决于输入）。页面的“已核验答案”展示费用、基线、末端储能量、备电满足情况以及每项引用的证据 ID；“候选充放电计划”展示选中策略、96 段轨迹、备电余量和归档结果 ID。计划是**合成输入上的候选仿真**，只在已测试方案中选择，不会下发设备动作，也不承诺全局最优。

“已核验”有明确范围：数值、单位、对象与归档证据经过硬检查；计划明细文件经过完整性检查，关键汇总数与已发布答案一致，但 96 个时段并未逐点生成核验 claim。它不代表现实设备或预测一定正确。页面底部的限制说明和 `simulation` 标记应与结论一起阅读。

页面会显示 run ID。已发布的结果也能由 API 读取：`GET /api/v1/runs/{runId}/answer` 返回核验答案；有能源计划的 run 还可用 `GET /api/v1/runs/{runId}/plan` 查看归档明细。关闭并重启 API 后，同一 run 的答案与明细仍可读取。

文档任务没有内置政策结论。需要先在**启动 API 的同一个终端**设置 `ONTOLOGY_LOCAL_OPERATOR_TOKEN`，然后在另一个 PowerShell 终端导入一份供本机演示的 Markdown/纯文本；下面是合成样例：

```powershell
$operatorToken = 'local-operator-only-change-this'
$body = @{
  title = '合成巡检说明'
  mediaType = 'text/markdown'
  content = "# 巡检说明`n北区设施每年巡检两次。"
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/v1/operator/documents' `
  -Headers @{ Authorization = "Bearer $operatorToken" } `
  -ContentType 'application/json; charset=utf-8' -Body $body
```

若你改了启动终端中的 token，这里的 `$operatorToken` 也要使用同一个值。接口只接受有 `data-editor` 权限的 operator；业务页面不提供绕过权限的导入按钮。首版每个文档集合只允许导入一份，不同的第二份会返回 409，避免旧索引被悄悄覆盖。随后在页面选择文档任务，提问 `已导入文件中的巡检频率原文是什么？`；答案只能引用实际导入的原文，不会把相似词检索当成政策推断。

本地 profiles 只是部署替换方式的 fixture，不代表任意客户 schema 已自动接通；文档 profile 当前每个 collection 只允许一份受控导入文档。尚未交付开放式 Text2SQL、自由问答/抽取、通用规则推理、实体跨源消歧、真实模型/JEV 或设备控制；逐时段能源明细经过完整性校验并与核验摘要核对，但未逐点作 claim 核验。接入边界和验证命令见[本地产品使用与验收说明](docs/local-product.md)。

## 设计思路：框架与场景分开

当前产品把“客户数据长什么样”“业务问题是什么意思”“用哪个运行时和工具”“如何核验回答”放在不同层。核心控制器和工具协议不认识客户的表名；物理字段与单位换算由部署侧 mapping 说明，能源计算留在场景扩展中。这样换一份数据结构时，原则上改来源、预处理和 mapping，而不改控制器或核验流程。

| 层 | 职责与替换边界 |
| --- | --- |
| `contracts / core / application` | 定义 run、预算、阶段、工具、证据、核验与发布契约；保持行业无关。 |
| 行业语义与部署 mapping | 前者说明对象/关系的业务含义，后者说明客户的物理表、字段、单位和身份如何映射到这些含义；二者分别版本化。 |
| 数据与模型适配器 | 承担 DuckDB/PostgreSQL、文档或模型协议等外部细节；通用控制器通过端口使用，不直接依赖驱动。 |
| Agent runtime 与 ToolGateway | runtime 决定有界的执行步骤，gateway 负责已注册工具的权限、预算和证据。此本地入口固定使用受控 runtime，不能靠页面的执行路径下拉框替换它。 |
| 场景计算与页面 | 家庭能源公式、候选策略和轨迹属于领域扩展；页面负责输入与展示，不在浏览器里推算“已核验”结果。 |

```mermaid
flowchart LR
  UI[浏览器：profile、任务、问题] --> API[Fastify API：创建 run]
  API --> CTRL[WorkflowController：预算、阶段、发布]
  CTRL --> RT[注册任务 runtime]
  RT --> GW[ToolGateway：授权、限额、证据]
  GW --> Q[data_query：语义查询]
  Q --> MAP[版本化语义 mapping]
  MAP --> DB[DuckDB：能源或交通数据]
  GW --> D[document_search：受控文档 span]
  GW --> C[场景计算：能源候选计划]
  Q --> EV[Postgres 证据记录 + 本地不可变 blob]
  D --> EV
  C --> EV
  EV --> VERIFY[硬核验：数值、事实、引文与来源]
  VERIFY --> ANSWER[Postgres：已发布答案]
  ANSWER --> UI
  EV --> DETAIL[只读计划明细：完整性与摘要一致性]
  DETAIL --> UI
```

这个切片具体演示了两种来源的同一语义：A 的 `soc_readings_wide(site_key, sample_utc, soc_percent)` 直接存百分数；B 的原始 `soc_metrics_long(asset_id, time_utc, metric_code, number_value, unit_code)` 先筛选 SOC 指标并物化成规范表，再用显式比例换算。两者都映射为 `battery_soc_reading` 的 `site_ref / recorded_at / soc_percent`，所以同一个语义查询计划能得到同口径结果。这里的整形是已声明的演示代码，不是对任意客户长表的自动识别。

一次运行先锁定 profile、版本化 task ref、task input digest 与来源权限。runtime 只能执行注册任务，经真实 gateway 调用 `data_query` 或文档检索；来源结果与最终草稿分别作为不可变 artifact 归档。数字 claim 和非数字 typed assertion 都绑定证据指针并硬核验，通过后才发布。回答与运行状态存 PostgreSQL，结果文件存本地 blob；API 重启后仍可按 run ID 读取。计划明细只从发布答案引用的仿真证据读取，不重新计算，也不访问设备。

产品方向是把本体语义作为可选增强：简单问题可以直接查数据，复杂问题可借助语义、检索或领域计算；不要求每个请求先做本体推理。这个本地切片刻意走语义查询，以检验 A/B 映射是否真的复用同一个问题。

当前页面已装配能源、交通与 operator 文档任务，但它们是本地受控 fixture，不是任意行业/客户连接器。仓库其他文档抽取、身份消歧、规则物化与模型组件仍未全部装配成可操作流程。JEV 概率决策、生成式规划、RAG/联网搜索、客户数据库上传和真实设备控制不能从本地页面使用；DataOS 不是本体推理服务的前提。

## API 与数据存放

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/runs/scope?profileId=home-energy-demo-wide&version=1.0.0` | 查看所选 profile 允许的工具与范围。B 使用 `home-energy-demo-long`。 |
| `POST /api/v1/runs` | 提交问题、站点、约束与 profile；返回 run ID。 |
| `GET /api/v1/runs/{runId}`、`GET /api/v1/runs/{runId}/events` | 查看运行状态与公开进度事件。 |
| `GET /api/v1/runs/{runId}/answer` | 读取已发布答案；运行中返回 202，失败且无答案时返回 404。 |
| `GET /api/v1/runs/{runId}/plan` | 读取已发布储能计划的归档明细；纯 SOC 问答或失败运行返回 404。 |
| `POST /api/v1/operator/documents` | 由配置 bearer token 的 operator 导入一份受控 Markdown/plain-text 文档；普通 business 用户返回 403。 |

API 默认只监听 `127.0.0.1:3000`，本地身份是开发用单租户配置，不是对外服务的登录/权限系统。`platform/.env.local` 保存本地应用数据库连接并被 Git 忽略；PostgreSQL 使用 Docker 命名卷保存控制数据，结果 blob 默认在被 Git 忽略的 `platform/apps/api/.local-data/blobs`。这个切片按单 API 实例使用，工作流状态写入尚没有跨进程版本 CAS，不能据此部署多副本。

## 如果要接入下一份真实数据

先写出 3–5 个代表问题及正确/错误样例，再确认来源权限、实际 schema、单位、时间和站点身份。对普通列名差异，新增客户 mapping；对 `metric_code / time / value` 或嵌套结构，先做可追溯的预处理/视图；遇到新协议才增加来源适配器。接着把来源、mapping、行业语义版本与需要的 runtime/工具/计算能力装配成 profile，跑同口径回归和缺口用例，最后再接页面。可复用的概念、规则和评测留在共享行业资产；客户数据、密钥与具体身份裁决留在客户环境。详细边界见[多行业异构数据方案](docs/scenario-decoupling-2026-09-23.md)与[PRD](tasks/prd-industry-semantic-agent-v0.2.md)。

## 验证与排障

在 `platform/` 下执行 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test`；真实浏览器验收先执行 `pnpm run build:web`，再执行 `pnpm run test:e2e`。浏览器用例会使用独立的临时 PostgreSQL 和 Chromium，不向本地演示库插入预制答案。

若首页只显示 `HTTP_500`，先检查 API 日志与上面的 scope 接口；若提问后显示 `INTERNAL_ERROR`，保留 `traceId` 并检查 API 终端，不要把它当成“问题没有答案”。`prepare:local` 首次建库连接中断时，用 `docker compose ... up -d --wait` 等待数据库健康后重跑，**不要删除已有数据卷**。如果 API 的 3000 端口或页面的 5173 端口已被占用，先停掉旧的 `dev:local` 进程，避免新旧代码同时运行。服务进程不会因 `git pull` 自动切换到新代码；更新代码后重启 `pnpm run dev:local`。

## 项目资料

- [最新工作交接](HANDOFF.md)
- [PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md) · [SPEC v0.2](tasks/spec-industry-semantic-agent-v0.2.md) · [家庭充电储能场景](tasks/scenario-home-energy-hackathon.md)
- [任务清单](.autoresearch/issues/INDEX.md) · [需求覆盖](.autoresearch/issues/coverage.md) · [模型开发与代码审查约定](AGENTS.md)
- [当前实现逆向规格](docs/SPEC-as-built-2026-09-23.md) · [代码审查清单](docs/reviews/2026-09-23-code-review.md) · [多行业解耦方案](docs/scenario-decoupling-2026-09-23.md) · [Palantir 调研](docs/research/palantir-industry-assets-2026-09-23.md)

TypeScript 工作区位于 `platform/`。当前实现不依赖历史 Python 演示原型；LOCAL 与 GitHub Issue 的映射以[任务 manifest](.autoresearch/issues/manifest.json)为准。
