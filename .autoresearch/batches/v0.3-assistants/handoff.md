# v0.3 实施交接

已在 [Yijtu/ontology](https://github.com/Yijtu/ontology/issues?q=is%3Aissue+is%3Aopen+label%3A%22batch%3Av0.3-assistants%22) 创建 72 个 GitHub Issues（A 47 / B 25），规格和任务文档已发布到 feat/electrical-costing-poc。本次只发布文档与任务，未开始功能实现或运行 loop-it。

## 新 agent 从哪里开始

先获取规划分支，读取本目录 [INDEX.md](INDEX.md)、[manifest.json](manifest.json)、[coverage.md](coverage.md)。首批规格提交为 cb3131d63e51922f4c4ab235396de051c5987c36；实际文档更新和全部远程编号以当前规划分支为准。

从 [#169](https://github.com/Yijtu/ontology/issues/169)（V03-001）开始核对已有能力、旧任务与 WIP，再按 manifest.topological_layers 和每个 Issue 的 Dependencies 执行。A 读取通用 PRD、主 SPEC 和资产／执行两个分册；B 开发前再读总体 PRD 与造价 SPEC。

来源 hash 使用 UTF-8 文本、移除 BOM 并将 CRLF 归一到 LF 后 SHA256，避免跨操作系统检出造成假漂移。manifest.input_sha256 校验当前规格；publication.spec_input_sha256 保存首次远端规格提交的版本。若功能要求漂移，先同步任务和测试覆盖。

## 分支、WIP 与阶段门槛

- 文档工作区 D:/work/ontology-core-main 目前用于 feat/electrical-costing-poc。源代码基线 main@19c411e8db444e289e8c3ec0395ae909f2534601；通用研发快照 feat/core-planning-provenance@d17c7b520298703feb65f86761f34f1557927aca，已有未提交代码。开工重新核对，不按目录名猜分支。
- 通用研发使用 feat/core-planning-provenance 或适合的隔离工作区，保留已有修改。规划分支包含造价文档；将纯规划文件带入通用工作线时只迁移必要文档，不整枝合并未审查代码，不自动 stash/reset。
- A 通过 [#218](https://github.com/Yijtu/ontology/issues/218) 完成独立整栈验收、审查、README、迁移及 PR 合入 main，记录真实 main SHA。Issue 关闭本身不替代这些证据。
- B 的三张盘点卡 [#170](https://github.com/Yijtu/ontology/issues/170)、[#171](https://github.com/Yijtu/ontology/issues/171)、[#172](https://github.com/Yijtu/ontology/issues/172) 可提前；专属代码必须先经 [#219](https://github.com/Yijtu/ontology/issues/219) 同步已验收 main 并通过兼容回归。发现通用缺口先回 main，再同步。
- [#238](https://github.com/Yijtu/ontology/issues/238) 只证明内部合成整栈；[#227](https://github.com/Yijtu/ontology/issues/227) 需要真实客户接口/许可/版本，[#239](https://github.com/Yijtu/ontology/issues/239) 需要真实模型/配对 gold/授权验收人，[#240](https://github.com/Yijtu/ontology/issues/240) 是完整 MVP 退出。缺资源不伪完成。

## 任务筛选与 loop-it

当前用户只要求创建 Issues，并将实施交给另一个 agent；本次不启动 loop。后续已获得实施授权的 agent 使用以下筛选，而不是扫描整个旧队列：

~~~powershell
gh issue list --repo Yijtu/ontology --state open --label 'batch:v0.3-assistants' --limit 100 --json number,title,labels,body
~~~

以 manifest.github_allowlist 为精确范围，以 Dependencies: #N 和阶段 gate 判断前置完成。先做 A，B 仅三项 discovery 可先行；真实外部条件保持明确就绪状态，不因盘点完成变成业务已签核。保留现有 .loop-state.json，不能覆盖旧执行记录或自动扩大 allowlist。

## 可直接交给另一 agent 的提示

> 开发 Yijtu/ontology 的 batch:v0.3-assistants。先获取 feat/electrical-costing-poc 上的发布文档，读取 .autoresearch/batches/v0.3-assistants/{INDEX.md,manifest.json,handoff.md,coverage.md}，按其中映射只处理这 72 个 GitHub Issues。先做 V03-001，核对主线/WIP和已完成能力，按依赖只实现实际缺口。A 研发在通用工作线完成，独立验收并 PR 合入 main；B 先同步已验收 main 再做专属行业资产、适配和前端。每卡完成适用测试/审查，更新证据；不削弱规则、来源、精度、权限、预算和核验以过关，不把合成验证或 Issue 关闭当真实业务验收。保留已有未提交工作、旧任务和 loop 状态。

## 验证与内容边界

- 适用工程检查在 platform/；真实浏览器先 build:web 再 test:e2e（Vitest 配置中使用 Playwright chromium）。完成证据记录实际命令和结果，计划测试 ID 不是通过证明。
- 密钥、客户原始资料、代码和真实价格留在授权环境。共享仓库只含通用设计、合成／获准脱敏fixture与适当引用。
- 旧 manifest 的原始 hash 仅证明这次本机保留，没有重置历史任务；在别的检出环境核对 Git 历史与原内容，不用 EOL 差异认定任务改变。
