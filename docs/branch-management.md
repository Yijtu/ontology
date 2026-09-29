# 分支与工作区管理

更新：2026-09-29。

## 当前四条工作线

| 分支 | 用途 | 本机工作目录 |
| --- | --- | --- |
| `main` | 已验收的通用 Core 与可复用资产；新功能默认从这里开始 | 本机未单独检出；需要查看主线时使用 GitHub，或在干净工作区切换 |
| `feat/electrical-costing-poc` | 第一单电气桥架造价的方案与后续实现 | `D:/work/ontology-core-main` |
| `feat/anker-home-energy` | Anker 家庭能源场景与验收 | `D:/work/ontology` |
| `feat/core-planning-provenance` | 尚未完成的通用规划运行时与规则溯源集成 | `D:/work/ontology-main-decoupling` |

工作目录是 Git worktree，不是另一个产品或独立仓库。文件夹名可以与当前分支名不同。`D:/work/ontology/.git` 是共享 Git 仓库，另外两个工作区依赖它。

电气桥架项目的当前范围和开工顺序见[第一单 POC 方案](poc/electrical-costing/first-poc-plan-2026-09-29.md)。它仍处于方案阶段，不代表报价功能已经交付。

## 命名和生命周期

- `main`：稳定主线，不放未验收的临时实现、客户私有数据或环境密钥。
- `feat/<具体能力或场景>`：如 `feat/electrical-costing-poc`。名称用小写英文和连字符，表达正在做什么；不用 `main-*`、`local-*` 或日期替代目的。
- `fix/<具体问题>`、`docs/<文档主题>`、`chore/<工程事项>`：对应修复、纯文档和维护。
- `archive/<主题>-YYYY-MM-DD`：仅用于保留未合并的历史提交的标签，避免旧实验继续占用活动分支列表。

每条分支对应一个明确交付范围。新任务优先复用空闲且合适的工作区；只有确实需要并行隔离时才新增 worktree。Anker 和造价分支服务当前项目，不作为永久的“一行业一个分支”知识库。

## Core 与场景如何协作

1. 先定义本次功能范围、输入输出和验收，不从“所有旧分支都有代码”推断它们可直接合并。
2. 通用修复和行业实现分开提交。Core 改动保持端口边界，行业语义、领域计算、客户适配和部署配置分开保存。
3. 通用改动经适用测试和审查后通过 PR 回流 main；场景按需同步主线。可复用的行业资产也经过脱敏与验收进入共享主干。
4. `feat/core-planning-provenance` 是未完成工作，不是造价项目的默认基线。不能为了使用一小块能力直接整枝合并所有研发改动。
5. 共享或已推送分支优先用普通同步/merge；不擅自 rebase、强推改写他人使用的历史。个人尚未共享的短期分支可按团队约定整理提交。

行业资产积累在代码和版本化声明中：语义定义、确认过的规则、单位与映射经验、领域端口、测试和合成评测。客户原文、报价、密钥、身份裁决和实际价格快照留在授权环境，不进入共享资产。

## 日常使用

先到所需工作区确认状态；不要因为目录叫 `ontology-core-main` 就直接推向 main：

```powershell
cd D:/work/ontology-core-main
git branch --show-current
git status --short
git worktree list
```

只有干净且空闲的工作区才能切换用途。已有未提交代码时保留原分支和文件，选择另一个合适工作区；不自动 stash、reset 或覆盖。

显式推送当前目标分支，并设置对应 upstream：

```powershell
git push -u origin feat/electrical-costing-poc
```

后续确认 upstream 与当前分支同名后，可以使用普通 `git push`。不要给功能分支设置 `origin/main` 为 upstream。

## 完成后怎么清理

1. 确认没有未提交文件、进行中的 PR、服务或任务依赖该工作区。
2. 通过祖先关系证明全部提交已被保留分支包含；补丁等价不等于原始提交仍有引用。
3. 未合并的独有提交先创建归档标签，并核对标签与原 HEAD 一致；需要跨机器恢复时先把标签发布到远端。
4. 清理原分支引用，保留 main 和正在工作的分支。已合并 PR 的临时集成分支及时移除。
5. 不删除其他任务需要的工作目录、共享 `.git`、客户资料或数据库。工作区归档和 Git 分支清理分别处理。

从归档标签恢复时，新建具有明确用途的分支，而不是把归档标签当活动分支继续推进：

```powershell
git switch -c feat/schema-extraction-followup archive/ontology-reasoning-2026-09-29
```

这个示例要求当前工作区干净，且目标分支尚不存在。

## 本次名称映射

| 原名称 | 新名称或处理 |
| --- | --- |
| `feat/brige_cost` | `feat/electrical-costing-poc` |
| `feat/local-poc-core-20260923` | `feat/anker-home-energy` |
| `feat/main-core-product-20260928` | `feat/core-planning-provenance` |
| `integrate/clean-core-main-20260929` | PR #168 已合并，清理本地/远端临时分支 |
| `feat/main-scenario-decoupling` | 已被 main 包含，清理本地分支 |
| `feat/anker-a4-explanation`、`feat/poc-core-capabilities` | 原始提交已被 Anker 保留线包含，清理本地分支 |
| `feat/ontology-consistency` | 补丁已回流但原始 SHA 未合并；先保留 `archive/ontology-consistency-2026-09-29` 标签，再清理旧分支 |
| `feat/ontology-online` | 补丁已回流但原始 SHA 未合并；先保留 `archive/ontology-online-2026-09-29` 标签，再清理旧分支 |
| `feat/ontology-reasoning` | 补丁已回流但原始 SHA 未合并；先保留 `archive/ontology-reasoning-2026-09-29` 标签，再清理旧分支 |

上述清理以实际提交关系、标签和远端核对结果为准。代码中的历史实施记录可以保留原分支名作为当时事实；当前入口和新的任务交接使用新名称。原始 HEAD、清理前状态和恢复记录另存本机归档目录。

GitHub 官方改名会更新部分关联引用，但如果被改名分支是未合并 PR 的 head，PR 会关闭；因此改名前必须检查 open PR。本次采用官方改名接口处理已推送的活动分支，避免仅复制新分支后遗留旧分支。[GitHub 分支改名说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/renaming-a-branch)。
