# Ontology Core

把业务资料变成可审核的知识，再带着依据回答问题。

一张台账里写着哪些设备，一份制度里规定了何时检修——Core 把资料、业务定义、规则和项目数据放进同一条工作流程：核对候选、决定身份、审核发布正式事实，再沿着答案找回原文和历史版本。

这是 v0.3 **A 阶段**的通用 Core，可独立使用。行业专属的资产、函数和页面（如造价）挂在它之上，不修改公共核心。

## 两个公共助手

Core 提供两套实际可操作的公共工作区，前端共用一套框架，专业视图由场景挂载。

### 本体生成助手 · 面向行业维护者

把行业资料整理成可审核、可发布、可挂载的行业资产。

- **行业工作区与资料**：创建行业工作区，导入 UTF-8 文本、JSON、CSV、XLSX；保留原始文件、解析版本与修订，重复导入不丢原始行标识。
- **解析与物理映射**：CSV／XLSX 可选 sheet、确认列对应、预览规范值与原始单元格；解析总数、成功、待处理、失败可见；不支持的表头显式提示，不默默猜列。
- **定义／规则／动作候选**：按资料生成有来源的类型、属性、关系、规则与动作候选，可编辑、拒绝、合并术语、修订端点；不受支持或未绑定能力的规则保存为不可执行，动作只绑定已注册能力。
- **实例抽取与确认**：按已发布 Schema 抽取实例，保留原始／规范值与来源；字段确认与身份裁决可追溯；未知字段和关系端点进入待确认。
- **合成验证与发布**：用隔离标记的合成样例验证规则／动作；发布不可变、可导出、可重新挂载的行业包，含来源索引与版本差异。

### 业务实践助手 · 面向业务用户

把行业包与项目数据用起来，给出有依据、可核验的结果。

- **项目与数据**：新建项目、挂载行业包版本、导入并确认记录；只有经审核发布的数据进入正式查询范围，未同步不冒称可查询。
- **自然语言任务**：用业务问题查询，系统路由到当前授权项目与能力——属性／实体查询、有限规则判断、受限关系导航、文档问答、已注册计算；歧义给出选项，超范围明确拒绝。
- **规则与关系**：区分原始属性与规则推得的判断；未知、冲突与明确反证分开表达，缺信息不默认为 false；关系导航返回实体、版本、来源与完整性。
- **依据追溯**：从结论展开实例前提 → 规则及版本 → 派生结果，并定位前提的原始片段／单元格；引用内容、locator 与摘要一致。
- **确定性计算**：已注册的版本化 compute 按固定输入、函数版本与授权执行，保存输入／输出工件与逐字段计算证据；模型不能给缺失数值编造结果。
- **核验与发布**：类型化结果按字段、单位、时间、来源、版本做硬核验；只发布同一已核验版本，正文修改须重新核验。
- **文档问答**：导入授权文本后建立索引，检索本项目实际片段并返回固定修订／span；检索不到依据时明说缺依据。
- **历史与导出**：输入、定义、映射、函数与资料变更产生新修订，旧结果保留当时快照与证据；支持带状态、版本与来源索引的结构化 JSON 导出。

## 共同保证

- **证据与来源**：每个结论都能回读授权原件、版本、字节／行摘要与定位。
- **隔离**：租户、空间与项目隔离；合成样例不会被当成真实事实。
- **确定性优先**：金额与领域计算只由确定性代码产出；预算、取消、重试与幂等有界，取消后的迟到结果不发布。
- **可替换**：行业、物理映射、runtime、业务查询后端与 MCP 传输都可替换，公共核心不含行业判断。

## 从两行台账开始

把下面内容保存为 UTF-8 的 `assets.csv`：

```csv
asset_id,asset_network_code,asset_workshop_code
DEMO-ASSET-001,DEMO-NET,WS-A
DEMO-ASSET-002,DEMO-NET,WS-A
```

在首页选择“工业资产维护”，新建项目，上传 CSV、确认映射并绑定记录。接着生成事实候选，核对字段与身份，批准并发布实例记录，再到候选审核页批准并发布语义事实。

**如果只审核并发布第一条，正式数据集中就只有第一条。** 第二条仍是待核对资料。查看第一条的来源，还能回到原文件的 `A2` 单元格。

这条流程已经在独立实例中实跑，也验证了进程重启后数据与来源仍可读取。

## 本机跑起来

需要 Node.js 22+、pnpm 和已启动的 Docker Desktop。下面从仓库根目录开始，在 PowerShell 中运行；三个端口需空闲。

```powershell
cd platform
pnpm install --frozen-lockfile

$coreProject = 'ontology-core-demo'
$env:CORE_API_PORT = '3001'
$env:CORE_WEB_PORT = '5174'
$env:CORE_PG_PORT = '54330'
$env:CORE_POSTGRES_PASSWORD = Read-Host '设置本机演示数据库密码'
$env:CORE_ENABLE_OPERATOR_ROUTES = 'true'
$env:CORE_ENABLE_MODELS = 'false'
$env:CORE_ENABLE_JEV = 'false'
$env:CORE_OBJECT_DIRECTORY = Join-Path (Get-Location) '.core-data/objects'

docker compose --project-name $coreProject --file deploy/core/compose.yaml up --detach
$corePassword = [uri]::EscapeDataString($env:CORE_POSTGRES_PASSWORD)
$env:CORE_CONTROL_DATABASE_URL = "postgresql://postgres:$corePassword@127.0.0.1:$($env:CORE_PG_PORT)/ontology_core"
pnpm exec tsx scripts/prepare-core-db.ts
pnpm exec node scripts/dev-core.mjs
```

就绪后打开 **[http://127.0.0.1:5174](http://127.0.0.1:5174)**。准备命令应用当前迁移并生成本地配置；原件保存在 `.core-data/objects`。停止、重启、独立实例和更多配置见[本机启动指南](platform/docs/core-local-startup-2026-09-28.md)。已有同名演示环境时，先按指南选择独立项目与端口。

## 默认与边界

- **默认关闭外部模型**：结构化资料导入和人工审核可以先走起来；自动生成和模型问答需另行配置模型。页面顶部的“模型设置”可填写服务地址、模型名称和密钥，测试连接并保存，重启 Core 后生效。
- **内置场景是合成演示**：真实客户资料与模型效果需要单独验收。
- **资料格式**：本阶段承诺 UTF-8 文本、JSON、CSV、XLSX；PDF／扫描件／DWG 不作为已承诺格式。
- **不在本阶段**：造价专业资产、客户报价函数、权威价表、报价导出等专属内容属 B 阶段，挂在 Core 之上。

## 继续了解

- [本机启动与小例子](platform/docs/core-local-startup-2026-09-28.md)
- [Core 的设计与边界](tasks/spec-main-core-product-2026-09-28.md)
- [A 阶段验收记录](platform/docs/v03-a-core-acceptance-2026-10-11.md)

开发检查从 `platform/` 运行 `pnpm run verify`；浏览器验收先运行 `pnpm run build:web`，再运行 `pnpm run test:e2e`，需要 Chromium 和 Docker。
