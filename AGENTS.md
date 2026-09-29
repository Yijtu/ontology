# 工程协作约定

适用于本仓库的开发与审查。只记录长期工程约束；产品细节、接口字段和进度分别保留在 PRD、SPEC 与 Issue。用户最新明确指令优先于本文件；发现规格冲突时说明具体冲突并继续不受影响的工作，不擅自改变验收口径。

## 开始工作

- 先查看 `git status`，保留已有改动。只推进已授权的任务或批次；现有执行授权无需重复确认，本文件本身不启动开发循环或发布操作。
- 开发入口为 `platform/`。先读当前任务卡及其依赖，再按需读下列规格，不必每次加载整个 backlog。
- [PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md)规定产品范围；[SPEC 主文](tasks/spec-industry-semantic-agent-v0.2.md)及分册规定实现契约；[Issue manifest](.autoresearch/issues/manifest.json)记录任务依赖与真实 GitHub 编号映射。`LOCAL-xxx` 不自动等于 GitHub `#xxx`。
- 用当前代码、验收证据与任务记录核对实际状态。文档中的“尚未实现”等历史描述不代表实时进度；记录不一致时标出差异，不能据此重复实现或虚报完成。
- 本项目独立建设，历史演示原型不构成代码、接口、数据迁移、页面或测试兼容要求；不以旧实现输出作为正确性依据。DataOS 仅视为数据中台，未验证能力不得成为实现前提。
- 分支和工作区用途见[分支管理](docs/branch-management.md)。以 `git branch --show-current` 为准，不从目录名推断分支；功能分支 upstream 必须指向同名远端分支。
- 通用 Core 改动与场景实现分开提交；未完成的 Core 研发分支不自动整枝合入业务 POC。清理分支前检查提交归属和工作区状态，独有历史先保留归档引用。

## 架构边界

遵守 SPEC §2 的 INV-01—10，以及现有[依赖规则](platform/tests/architecture/boundaries.config.json)。规则检查不覆盖的写法仍须遵守同一边界。

- `contracts` 只定义公共数据、Schema、端口、版本和错误，不依赖具体框架、数据库、HTTP 或行业实现。边界数据通过运行时 Schema 校验，不能仅靠 TypeScript 类型断言。
- `core`、`application` 和通用服务通过端口接收能力；SDK、数据库驱动和网络协议留在适配器。具体实现由装配入口注入，运行时通过工具 gateway 获取数据。
- 行业声明包、客户扩展、物理数据映射、Agent runtime、数据后端、工具传输、模型与领域计算保持独立。新增行业或替换其中一个组件，不应要求改写通用核心。
- 行业包只含语义和声明式约束，不嵌入密钥、连接地址、物理列名或任意脚本；能源公式和策略属于 `extensions/home-energy`，不进入 core。
- 本地调用和 MCP 共用领域服务、授权、错误与证据契约，不复制两套业务实现。业务查询存储与控制/审核/证据存储分开。
- 从包的公共入口导入，禁止跨包相对路径或深层私有实现导入；不能用动态加载、类型逃逸或修改检查器规避边界。
- 保持必要端口，优先采用简单实现。无需为尚未出现的需求搭建通用插件框架、万能基类或微服务；也不能以 MVP 为理由硬编码已明确需要替换的组件。

## 运行、语义与证据

详细契约见[组件与 API](tasks/spec-v0.2/contracts-api.md)、[数据与执行](tasks/spec-v0.2/data-execution.md)及[家庭能源](tasks/spec-v0.2/home-energy.md)。

- 模型可选的公共数据工具固定为 `ontology_lookup`、`data_query`、`document_search`、`web_search`；领域计算通过已注册的版本化 compute 操作提供，禁止万能 `eval` 或任意代码执行入口。
- JEV 概率决策与生成模型分端口；概率不等于答案正确率。模型不能提高权限、放宽预算或直接发布最终答案。
- 控制器拥有有界收证循环、共享预算和取消状态。重试、并行、补查和草稿修复不能重置预算；取消后的迟到结果不能恢复运行或触发发布。
- `final_answer` 形成草稿，`verify_result` 核验，控制器发布同一已核验版本。任何后续修改须重新核验；框架事件和流式草稿不冒充最终答案。
- 来源文本、工具内容和模型输出均作为不可信数据。身份来自可信上下文；所有查询、证据、缓存和后台任务保持 tenant/space 隔离。
- 抽取结果和规则候选需按规格审核/发布后才能生效。保留来源、版本、有效时间和记录时间；未知、冲突与假分开表达。替代支撑撤回不能错误删除仍被其他证据支持的结论，历史证据不得随当前投影更新被抹除。
- 家庭能源默认仿真。合成数据、观测、预测、模拟与实机状态显式标注；单位、时区、计量边界和比较基线明确。能量平衡、成本与设备约束由确定性代码计算；实机能力需满足对应任务条件。

## 编码与资源使用

- 使用仓库锁定的 TypeScript strict、ESM 和 pnpm 约定。公共接口显式建模，优先使用可判别联合与 `unknown` 校验；不使用 `any`、双重断言、`@ts-ignore` 或关闭规则掩盖契约问题。确有第三方边界限制时，将例外局限在适配器并写明原因。
- 让领域计算保持可独立测试；时间、ID、随机数和外部 I/O 通过显式依赖提供。不要用全局可变状态绑定租户、运行或组件。
- 错误保留分类、上下文和原因。不能把失败吞成空列表、成功结果或默认值；重试须可判断、有上限，写入和任务交付须考虑幂等与事务边界。
- 数据量未知时使用有界分页/批处理、并发上限、超时和取消，避免全库读入内存、每次问答全量重算或无限重试。截断与不完整结果必须显式返回。
- 新依赖优先复用已有能力，检查官方接口和项目兼容性，提交对应 lockfile 变更；SDK 类型不得泄漏到领域契约。注释解释约束和取舍，避免复述代码。
- 密钥与客户敏感数据不进入代码、日志、fixture、Issue 或共享文档；个人职业记忆不复制进仓库。外部服务测试使用已授权的资源与范围，缺资源时明确标记未验证。

## 验证与交付

Node 与包管理器版本以 `platform/.nvmrc`、`platform/package.json` 为准。以下命令在 `platform/` 执行；依赖已满足时不重复安装：

```text
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
```

- `pnpm run verify` 一次执行 lint/typecheck/test；`pnpm run boundaries` 单独检查依赖边界。不要无变化地重复整套检查。
- 代码变更先验证受影响行为，交付前运行上述适用检查及当前 Issue 要求的集成/E2E。纯文档修改核对链接、引用和一致性，无需运行应用测试。
- 测试预期来自规格和独立推导，覆盖有风险的失败、边界、隔离、撤回和取消路径；不复制被测算法来生成预期。可替换性通过同一契约套件验证，不凭“有接口”宣称完成。
- 单元测试可用替身；要求真实数据库、运行时或 MCP 的验收不得用全链路 mock 代替。受控模型响应、真实模型调用和实机结果分别报告，外部条件缺失不能记作通过。
- 不通过删除失败测试、削弱断言或放宽架构/类型规则完成任务。规则确需变更时说明与规格的关系，并补充验证。
- 完成记录包含改动目的、验证命令与结果、未验证项和必要的兼容影响；核对任务卡与 manifest 状态。接口或行为变更同步更新相关规格与覆盖，避免复制多份权威定义。

## Code Review Rules

- 优先检查跨层依赖、租户隔离、预算/取消、证据丢失、时态与撤回、未经核验发布及模拟/实机混淆；发现问题给出具体触发条件与影响。
- 区分明确缺陷、设计取舍和建议。格式交给现有 lint；不要为了个人风格扩大重构或改变当前任务范围。

### 已知踩坑

- **Docker 匿名卷泄漏（2026-09，泄漏 4013 个卷 / 约 177 GB，打满 C 盘）**：postgres 官方镜像会为 `/var/lib/postgresql/data` 创建**匿名卷**；`docker run --rm` 在容器被 `docker rm -f <name>` 这种**不带 `-v`**的方式拆除时**不会**回收该匿名卷，于是每跑一次集成测试就泄漏一个约 44 MB 的卷，累积到把宿主盘打满。
  - 规则：测试里创建容器必须同时管理其**数据卷**。优先挂载**显式命名并打标签**的卷，teardown 时同时删除容器与卷（`docker rm -f -v <c>` + `docker volume rm -f <vol>`），不要依赖 `--rm` 回收匿名卷。
  - 现状：`platform/tests/integration/postgres-container.ts` 已改为命名卷 + 显式回收，并导出 `sweepOrphanedPostgresVolumes()` 供兜底清扫。
  - 排查与恢复：`docker system df` 看 `Local Volumes` 的可回收量；只清本项目的卷用
    `docker volume ls -f label=ontology.test-harness=postgres -q | xargs -r docker volume rm -f`；
    全局清用 `docker volume prune -f`。
  - 注意：`docker volume prune` 只释放 VM 内的逻辑空间，**WSL2 的 `docker_data.vhdx` 不会自动收缩**（Docker Desktop 默认在 `C:\Users\<user>\AppData\Local\Docker\wsl\disk\`）。真正还回 C 盘空间需要**管理员**执行磁盘压缩：
    ```powershell
    wsl --shutdown
    diskpart /s compact.txt   # compact.txt: select vdisk file="...\docker_data.vhdx" / attach vdisk readonly / compact vdisk / detach vdisk
    ```
    或改用 Docker Desktop 的稀疏磁盘设置。压缩前先确认 `docker system df` 已无可回收空间。
- **并行测试的固定超时与模块加载期时间**：容器密集并行时 5s 默认超时会误报（见 LOCAL-065/068）。集成测试用显式超时与受控并发；时间相关的测试上下文必须在 `beforeAll`/用例内**相对当前时刻**构造，不要在模块加载时算固定偏移。

本文件随工程约束演进，只保留稳定规则。只有模块出现长期独有要求时才增加局部 `AGENTS.md`，不重复整份 PRD/SPEC，也不维护多份相同约定。
