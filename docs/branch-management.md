# 分支与工作区管理

更新：2026-09-29。

## 当前四条工作线

| 分支 | 用途 | 本机工作目录 |
| --- | --- | --- |
| `main` | 已验收的通用 Core 与可复用资产；新功能默认从这里开始 | 本机未单独检出；需要查看主线时使用 GitHub，或在干净工作区切换 |
| `feat/electrical-costing-poc` | 第一单电气桥架造价的方案；同步已验收主线后开发专属能力和前端 | `D:/work/ontology-core-main` |
| `feat/anker-home-energy` | Anker 家庭能源场景与验收 | `D:/work/ontology` |
| `feat/core-planning-provenance` | 现有通用研发工作线；优先复用以补双助手和业务执行，按能力验收回流 main | `D:/work/ontology-main-decoupling` |

工作目录是 Git worktree，不是另一个产品或独立仓库。文件夹名可以与当前分支名不同。`D:/work/ontology/.git` 是共享 Git 仓库，另外两个工作区依赖它。

最新顺序见[A 通用 Core PRD](../tasks/prd-generic-assistants-core-v0.3.md)与[总体／造价 PRD](../tasks/prd-ontology-and-business-assistants-v0.3.md)：通用能力和公共前端先进入 main，造价分支同步主线后完成专属 MVP。[第一单 POC 方案](poc/electrical-costing/first-poc-plan-2026-09-29.md)保留客户资料与函数静态核对。新需求仍处于 PRD 阶段，不代表通用功能已合并或报价已交付。

## 命名和生命周期

- `main`：稳定主线，不放未验收的临时实现、客户私有数据或环境密钥。
- `feat/<具体能力或场景>`：如 `feat/electrical-costing-poc`。名称用小写英文和连字符，表达正在做什么；不用 `main-*`、`local-*` 或日期替代目的。
- `fix/<具体问题>`、`docs/<文档主题>`、`chore/<工程事项>`：对应修复、纯文档和维护。
- `archive/<主题>-YYYY-MM-DD`：仅用于保留未合并的历史提交的标签，避免旧实验继续占用活动分支列表。

每条分支对应一个明确交付范围。新任务优先复用空闲且合适的工作区；只有确实需要并行隔离时才新增 worktree。Anker 和造价分支服务当前项目，不作为永久的“一行业一个分支”知识库。

## Core 与场景如何协作

1. 先冻结阶段 A 的范围、输入输出、有限支持范围与独立验收。优先复用通用工作线，保留当前 WIP；不从“旧分支有代码”推断整枝已经可合并。
2. 通用后端、公共双助手及行业无关契约／测试先经适用检查和独立审查，通过 PR 合入 main。可分能力增量合并，整体验收通过后记录阶段 A 的 main 提交 SHA。
3. 造价和其他仍在推进的场景分支同步该 main 基线，记录所用 SHA 并跑受影响回归；再以此开发本场景的资产、客户适配、计算函数与专业 UI。已有造价分支继续复用，不为了第二阶段再建重复分支。
4. 场景内发现通用缺口，独立任务／提交实现并验证，先回流 main，再同步回场景。行业声明、领域计算、客户映射、部署配置和场景 UI 不混在通用提交中。
5. `feat/core-planning-provenance` 和 Anker 的可复用模块需按能力核对必要依赖、迁移、装配与测试，再提取进通用交付；不能直接把未完成实验分支整枝合入业务 POC。
6. 共享或已推送分支优先用普通 merge 同步；不擅自 rebase、强推改写他人使用的历史。个人尚未共享的短期分支可按团队约定整理提交。

| 归属 | 内容 | 合并路径 |
| --- | --- | --- |
| main 的通用部分 | 建模／审核／发布、任务运行、工具和动作契约、类型化核验、证据、历史、公共前端及挂载入口 | 通用工作线 → 检查／审查 → main |
| 场景交付部分 | 桥架资产、客户报价适配、权威价源、税费／舍入口径、参数表单、报价表及专业导出 | 同步 main → 造价分支开发与业务验收 |
| 后续共享行业资产 | 经授权共享的行业定义、规则、映射经验、领域扩展及合成评测 | 独立脱敏／验收后回流；不因属于场景就永远留在分支 |

公共前端与场景界面分别装配，行业包只含声明。使用场景模块和版本化资产积累行业知识，Git 分支用于交付隔离。阶段 A 不依赖真实价格／客户报价样本；阶段 B 必须验收这些业务依据，不能以通用示例替代。

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

## 场景如何获取 main 的通用能力

本轮双助手规划的依赖已记录在[v0.3 任务批次](../.autoresearch/batches/v0.3-assistants/INDEX.md)：V03-047 独立验收并交付 main；V03-051 记录造价分支的同步与兼容门槛。范围／函数／样本的 V03-048～050 可以提前核对，场景专属代码卡统一等待上述主线门槛。通用变化只在 main 维护，专属资产、适配和 UI 留在场景分支。

以下是阶段 A 完成后的操作示例，本次仅更新规划，没有执行同步。先确认 main 已包含验收提交、当前工作区干净且没有别的任务操作 Git；有 WIP 时先由原任务完成或协调，不能自动 stash／reset。

~~~powershell
cd D:/work/ontology-core-main
git branch --show-current
git status --short
git fetch origin
git merge origin/main
git merge-base --is-ancestor '替换为阶段A验收的main提交SHA' HEAD
~~~

确认当前是 feat/electrical-costing-poc，最后一条用实际验收 SHA 替换占位符；退出码 0 才证明包含该基线。origin/main 可以比该基线更新，还需审查新增变更及迁移影响。同步后在 platform/ 运行适用检查和场景回归，再提交／push；其他活动场景在自己的工作区按同样方式同步。

出现冲突时按通用与场景职责解决，不用 ours／theirs 批量覆盖。测试和依赖核对未通过时不能写“已获取全部通用能力”。数据库迁移、配置和支持范围变化须同步记录，不只合并前端文件。

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
