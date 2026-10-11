# Ontology Core

把业务资料变成可审核的知识，再带着依据回答问题。

一张台账里写着哪些设备，一份制度里规定了何时检修——Core 把资料、业务定义、规则和项目数据放进同一条工作流程。你可以核对候选、决定身份、发布正式事实，也可以沿着答案找回原文和历史版本。

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

## 现在能做什么

- **读资料，建业务知识。** 保留文本、PDF、CSV、XLSX 的原始资料；为定义与规则候选核对真实来源，经过人工审核和独立题集验核后发布版本。
- **把项目数据变成正式事实。** 确认映射、核对字段、裁决身份；只有完成相应审核与发布的数据才进入正式查询范围。
- **执行任务，查看依据。** 运行已发布规则、登记过的计算及资料问答，查看结果、来源和历史。业务查询支持 DuckDB 与独立 PostgreSQL 后端。
- **让版本继续往前走。** 对新版本重新映射与抽取，可取消、审核、激活或撤回，并保留旧答案与其固定依据。

默认关闭外部模型。结构化资料导入和人工审核可以先走起来；自动生成和模型问答需另行配置模型。内置场景是合成演示，真实客户资料和模型效果需要单独验收。

## 继续了解

- [本机启动与小例子](platform/docs/core-local-startup-2026-09-28.md)
- [Core 的设计与边界](tasks/spec-main-core-product-2026-09-28.md)
- [本批验收记录](platform/docs/v03-a-core-acceptance-2026-10-11.md)

开发检查从 `platform/` 运行 `pnpm run verify`；浏览器验收先运行 `pnpm run build:web`，再运行 `pnpm run test:e2e`，需要 Chromium 和 Docker。
