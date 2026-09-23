# ontology

这是多行业语义与业务 Agent 平台的 TypeScript 仓库。**目前可直接运行的是家庭充电储能的本地 POC Core**：页面提问后，同一个 run 会执行 DuckDB 语义查询、候选计划仿真、证据归档与答案核验。演示数据是合成数据，不连接真实设备。

## 这个页面究竟能做什么

当前首页只有“业务问答”，因为它是一次 POC 的业务运行入口，不是数据接入或本体管理后台。它只识别两类明确问题：

| 问题 | 实际执行 | 页面能看到 |
| --- | --- | --- |
| “synthetic-home-1 的 SOC 均值是多少？” | 按所选 profile 将 `battery_soc_reading` 语义查询编译为受限 SQL，在 DuckDB 查询并计算平均值 | 站点、平均 SOC、单位、来源证据和核验状态。静态演示样本为 40% 与 50%，结果为 45%，不是实时设备读数 |
| “明天如何安排充放电，在满足备电约束下尽量降低电费？” | 先查询同一站点 SOC，再用合成负荷、光伏、电价和电池参数测试有限的候选策略 | 估算费用与无电池基线、期末储能量、备电检查；展开后可查看选中策略、96 个 15 分钟时段的充放电和储能量轨迹 |

页面不是开放式聊天机器人。问“电池容量是多少”等当前未实现的问题会明确失败；输入没有 SOC 数据的站点也不会改用别的站点或编造一个已核验答案。真实客户数据、设备状态和公司模型 API 尚未接入这个本地入口。

一次运行的操作顺序是：选择 A/B 数据结构 → 填站点及仿真假设 → 提问 → 查看运行进度与共享预算 → 查看已发布答案及证据 → 如果是计划问题，展开归档的计划明细。页面显示的 run ID 可以用于再次读取同一次结果。

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

如果页面只显示 `HTTP_500`，通常是页面打开时 API 尚未就绪；待终端出现 `Ontology POC Core API: http://127.0.0.1:3000` 后刷新页面，或点击“重试连接”。启动脚本现在会等 API 就绪后再启动页面。

需要停止数据库时，仍在 `platform/` 执行：

```powershell
$env:CONTROL_POSTGRES_PASSWORD = 'local-only-change-this'
docker compose -f deploy/local/docker-compose.yml stop
```

不要用 `down -v` 停止日常环境：它会删除数据库卷和已保存的运行记录。

## 怎么使用

首页各控件的作用如下。页面在当前打开期间保留表单输入，但它不上传客户文件，也不自动发现新的数据库表。

| 控件 | 当前本地切片的含义 |
| --- | --- |
| 数据结构 profile | **A：宽表遥测**直接读取 SOC 百分数列；**B：长表指标码**先把 `metric_code / time / value` 整形成规范表，再把基点值换算为百分数。两份 profile 的物理表和映射版本不同，逻辑问题相同。下拉框切换的是演示数据结构，不是行业或 Agent 内核。 |
| 问题 | 使用固定的 SOC 查询或储能计划意图。问题文本不会作为任意 SQL 或设备命令执行。 |
| 站点 | 默认为 `synthetic-home-1`。查询限定到该站点；不存在的站点返回数据缺口。 |
| 备电保留量 | 用户希望计划保留的电量，单位 kWh；只对储能计划问题生效。 |
| 光伏天气假设 | 晴天、阴天、暴风雨三组**合成预测**输入；它不是实时天气。只对储能计划问题生效。 |
| 执行路径、Web 搜索 | 通用工作台保留了执行路径偏好控件；这个本地切片实际使用固定的受控 runtime，不能靠下拉框对比 template/pi。Web 搜索在本地 profile 中禁用。 |

建议先分别选择 A 和 B，保持站点 `synthetic-home-1`，问同一个 SOC 问题，观察结果口径相同而来源版本不同；再问计划问题，改变备电保留量或天气，比较候选结果。可直接复制：

```text
synthetic-home-1 的 SOC 均值是多少？
明天如何安排充放电，在满足备电约束下尽量降低电费？
```

第一个问题只执行语义查询。第二个问题先查 SOC，再由确定性能源计算测试 `self_consumption`、`reserve_first`、`price_window` 三种候选（实际可行性取决于输入）。页面的“已核验答案”展示费用、基线、末端储能量、备电满足情况以及每项引用的证据 ID；“候选充放电计划”展示选中策略、96 段轨迹、备电余量和归档结果 ID。计划是**合成输入上的候选仿真**，只在已测试方案中选择，不会下发设备动作，也不承诺全局最优。

“已核验”有明确范围：数值、单位、对象与归档证据经过硬检查；计划明细文件经过完整性检查，关键汇总数与已发布答案一致，但 96 个时段并未逐点生成核验 claim。它不代表现实设备或预测一定正确。页面底部的限制说明和 `simulation` 标记应与结论一起阅读。

页面会显示 run ID。已发布的结果也能由 API 读取：`GET /api/v1/runs/{runId}/answer` 返回核验答案；有能源计划的 run 还可用 `GET /api/v1/runs/{runId}/plan` 查看归档明细。关闭并重启 API 后，同一 run 的答案与明细仍可读取。

本地入口尚未接入真实客户数据、其他行业、真实模型/JEV、任意 Text2SQL 或设备控制；逐时段明细经过文件完整性校验并与已核验摘要核对，但没有逐点作 claim 核验。接入边界和验证命令见[本地产品使用与验收说明](docs/local-product.md)。

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
  UI[浏览器：问题、站点、约束] --> API[Fastify API：创建 run]
  API --> CTRL[WorkflowController：预算、阶段、发布]
  CTRL --> RT[本地受控 runtime]
  RT --> GW[ToolGateway：授权、限额、证据]
  GW --> Q[data_query：语义查询]
  Q --> MAP[A/B 版本化 mapping]
  MAP --> DB[DuckDB：宽表或规范化长表]
  GW --> C[home-energy 计算：候选策略和仿真]
  Q --> EV[Postgres 证据记录 + 本地不可变 blob]
  C --> EV
  EV --> VERIFY[硬核验：数值、单位、主体、来源]
  VERIFY --> ANSWER[Postgres：已发布答案]
  ANSWER --> UI
  EV --> DETAIL[只读计划明细：完整性与摘要一致性]
  DETAIL --> UI
```

这个切片具体演示了两种来源的同一语义：A 的 `soc_readings_wide(site_key, sample_utc, soc_percent)` 直接存百分数；B 的原始 `soc_metrics_long(asset_id, time_utc, metric_code, number_value, unit_code)` 先筛选 SOC 指标并物化成规范表，再用显式比例换算。两者都映射为 `battery_soc_reading` 的 `site_ref / recorded_at / soc_percent`，所以同一个语义查询计划能得到同口径结果。这里的整形是已声明的演示代码，不是对任意客户长表的自动识别。

一次运行先锁定 profile 与来源权限。runtime 只能通过已注册的 `data_query` 操作查询或调用能源计算；工具返回后先归档结果和来源，再生成带证据指针的 claim。硬核验通过后才发布同一份答案。回答和运行状态存 PostgreSQL，结果文件存本地 blob；API 重启后仍可按 run ID 读取。计划明细接口只能从已发布答案所引用的仿真证据追到归档文件，不会重新计算，也不会访问设备。

产品方向是把本体语义作为可选增强：简单问题可以直接查数据，复杂问题可借助语义、检索或领域计算；不要求每个请求先做本体推理。这个本地切片刻意走语义查询，以检验 A/B 映射是否真的复用同一个问题。

这些接口为将来的行业/客户替换留下边界，但**有接口不等于本地产品已经挂载能力**：仓库中还有文档抽取、身份消歧、规则物化、检索、模型与其他行业声明等组件；当前首页没有把它们装配成可操作的流程。特别是 JEV 概率决策、生成式规划、RAG/联网搜索、客户数据上传和真实设备控制都不能从这个页面使用。DataOS 在此也不是本体推理服务的前提。

## API 与数据存放

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/runs/scope?profileId=home-energy-demo-wide&version=1.0.0` | 查看所选 profile 允许的工具与范围。B 使用 `home-energy-demo-long`。 |
| `POST /api/v1/runs` | 提交问题、站点、约束与 profile；返回 run ID。 |
| `GET /api/v1/runs/{runId}`、`GET /api/v1/runs/{runId}/events` | 查看运行状态与公开进度事件。 |
| `GET /api/v1/runs/{runId}/answer` | 读取已发布答案；运行中返回 202，失败且无答案时返回 404。 |
| `GET /api/v1/runs/{runId}/plan` | 读取已发布储能计划的归档明细；纯 SOC 问答或失败运行返回 404。 |

API 默认只监听 `127.0.0.1:3000`，本地身份是开发用单租户配置，不是对外服务的登录/权限系统。`platform/.env.local` 保存本地应用数据库连接并被 Git 忽略；PostgreSQL 使用 Docker 命名卷保存控制数据，结果 blob 默认在被 Git 忽略的 `platform/apps/api/.local-data/blobs`。这个切片按单 API 实例使用，工作流状态写入尚没有跨进程版本 CAS，不能据此部署多副本。

## 如果要接入下一份真实数据

先写出 3–5 个代表问题及正确/错误样例，再确认来源权限、实际 schema、单位、时间和站点身份。对普通列名差异，新增客户 mapping；对 `metric_code / time / value` 或嵌套结构，先做可追溯的预处理/视图；遇到新协议才增加来源适配器。接着把来源、mapping、行业语义版本与需要的 runtime/工具/计算能力装配成 profile，跑同口径回归和缺口用例，最后再接页面。可复用的概念、规则和评测留在共享行业资产；客户数据、密钥与具体身份裁决留在客户环境。详细边界见[多行业异构数据方案](docs/scenario-decoupling-2026-09-23.md)与[PRD](tasks/prd-industry-semantic-agent-v0.2.md)。

## 验证与排障

在 `platform/` 下执行 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test`；真实浏览器验收先执行 `pnpm run build:web`，再执行 `pnpm run test:e2e`。浏览器用例会使用独立的临时 PostgreSQL 和 Chromium，不向本地演示库插入预制答案。

若首页只显示 `HTTP_500`，先看终端是否已出现 API 就绪地址，再刷新或点“重试连接”；若 `prepare:local` 在首次建库时连接被中断，用 `docker compose ... up -d --wait` 等待数据库健康后重跑，**不要删除已有数据卷**。如果 API 的 3000 端口或页面的 5173 端口已被占用，先停掉旧的 `dev:local` 进程，避免同时运行两套本地服务。

## 项目资料

- [最新工作交接](HANDOFF.md)
- [PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md) · [SPEC v0.2](tasks/spec-industry-semantic-agent-v0.2.md) · [家庭充电储能场景](tasks/scenario-home-energy-hackathon.md)
- [任务清单](.autoresearch/issues/INDEX.md) · [需求覆盖](.autoresearch/issues/coverage.md) · [模型开发与代码审查约定](AGENTS.md)
- [当前实现逆向规格](docs/SPEC-as-built-2026-09-23.md) · [代码审查清单](docs/reviews/2026-09-23-code-review.md) · [多行业解耦方案](docs/scenario-decoupling-2026-09-23.md) · [Palantir 调研](docs/research/palantir-industry-assets-2026-09-23.md)

TypeScript 工作区位于 `platform/`。当前实现不依赖历史 Python 演示原型；LOCAL 与 GitHub Issue 的映射以[任务 manifest](.autoresearch/issues/manifest.json)为准。
