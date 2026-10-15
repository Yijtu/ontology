# 在本机跑起 Core

需要 Node.js 22+、pnpm 和已启动的 Docker Desktop。从仓库的 `platform/` 目录运行。依赖版本以 `package.json` 和锁文件为准。

> 启动与下列 CSV 示例已于 2026-10-11 在独立实例实测：54 个迁移、API/网页/代理就绪、人工发布与 A2 来源定位、进程重启后的数据保留均通过。相关修复已合入主线；本批生产基线为 `780a3b0`；完整批次进度见[验收记录](v03-a-core-acceptance-2026-10-11.md)。

## 第一次启动

下面使用一个独立的 Compose 项目。若已有同名环境，换一个项目名，并选择三个空闲端口；API、网页、数据库不能共用端口。

```powershell
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

看到 API 和网页均已就绪后，打开 [http://127.0.0.1:5174](http://127.0.0.1:5174)。如果改过 `CORE_WEB_PORT`，使用对应端口。

数据库准备命令负责迁移并生成忽略提交的 `.env.core.local`。其中保存的是非超级用户 `ontology_app` 的应用连接、端口和演示范围，不保存管理员连接或数据库服务器密码。API 启动本身不执行迁移。当前主线有 54 个迁移，数量会随开发变化。

`CORE_ENABLE_OPERATOR_ROUTES=true` 打开这台本机上的资料导入、审核和发布入口，便于走完整演示。模型和 JEV 分别关闭；导入结构化资料及人工审核无需调用外部模型。启动器检查端口占用、API 健康和网页就绪，并将网页的 `/api` 请求代理到此实例。

## 从页面配置生成模型

打开顶部“模型设置”，填写服务地址（只含域名和端口）、API 端点、协议、服务商模型名称和 API Key。内部配置名称通常保留默认值即可。先“测试连接”，再“保存配置（重启生效）”。连接测试最多 16 个输出 token、8 秒和 64 KiB，只验证通信与协议，不验证业务答案质量。

设置由本机服务端按租户和空间保存在对象目录的 `.core-settings/` 下，密钥不回传到页面，也不进入浏览器持久存储。相同服务地址留空会保留已存密钥；换服务地址必须重新填写或明确清除密钥。每次保存产生新修订，重启后使用新的模型组件标识，旧运行不会被静默改接到新配置。

保存后停止并重新运行 `scripts/dev-core.mjs`，刷新页面，核对“当前进程”的启用状态。该窗口只配置生成模型，不会自动启用 JEV 决策模型，也不会替代项目正式事实、已发布规则或任务就绪条件。窗口保存的配置会在下次 Core 启动时加载。

顶部“问答”与首页“开始业务问答”打开独立问答页面。先选项目、查看实际任务目录；自然语言能力仍受当前项目配置与注册任务范围约束。各功能页的“本页说明”列出了用途、开始前、完成后及可展开的操作步骤。

## 试一份小资料

把下面三行保存为 UTF-8 的 `assets.csv`：

```csv
asset_id,asset_network_code,asset_workshop_code
DEMO-ASSET-001,DEMO-NET,WS-A
DEMO-ASSET-002,DEMO-NET,WS-A
```

在首页选择工业资产维护场景，进入项目并新建项目。通过“导入资料”上传 CSV，确认映射后绑定记录。在项目记录中生成事实候选，再核对字段、确认身份、批准并发布实例记录；随后到候选审核页批准并发布语义事实。回到项目生成数据集，就能查看正式进入查询范围的行。

点击字段来源可以回到原始单元格：第一条资产位于 `A2`。上传成功、记录发布和正式事实发布是不同步骤，未经批准的候选不会因为导入了文件就进入正式数据集。

## 重启与停止

以后从同一个 `platform/` 目录启动，保留原 `.env.core.local` 和 `.core-data/objects`。在新窗口重新设置同一个项目名、数据库密码、`CORE_PG_PORT`，以及本机操作开关和对象目录，再运行：

```powershell
docker compose --project-name $coreProject --file deploy/core/compose.yaml up --detach
pnpm exec node scripts/dev-core.mjs
```

API/Web 端口和租户/空间从 `.env.core.local` 读取；Compose 仍需设置相同的 `CORE_PG_PORT`。迁移有更新时，重新设置管理员连接并执行准备命令；已应用迁移不会重复运行，校验和变化会被拒绝。

在启动窗口按 **Ctrl+C** 关闭 API 和网页。保留数据库数据的停止命令是：

```powershell
docker compose --project-name $coreProject --file deploy/core/compose.yaml stop
```

原始资料在对象目录，数据库在此 Compose 项目的命名卷中，两者需要一起保留。日常停止不删除卷或对象目录。

## 独立实例与更多配置

同机运行第二套实例时，使用独立仓库工作区、Compose 项目名、三个空闲端口、对象目录，以及明确的 `CORE_TENANT_ID` / `CORE_SPACE_ID` UUID。每个工作区有自己的 `.env.core.local`。启动器拒绝历史服务端口 `3000/5173/54329`，也拒绝远程或非 `ontology_core` 数据库。

默认业务查询后端是 DuckDB。通过 `PROJECT_BUSINESS_DATABASE_URL` 等配置可接独立的 PostgreSQL 业务数据后端；这与控制库的 `CORE_DATABASE_URL` 是两种连接。模型提供方、生产认证和客户数据源接入属于另行配置的能力，参考 [Core 设计](../../tasks/spec-main-core-product-2026-09-28.md) 与 [本批验收记录](v03-a-core-acceptance-2026-10-11.md)。
