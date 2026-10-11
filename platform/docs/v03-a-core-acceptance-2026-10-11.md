# Core v0.3 A 主线验收记录

状态：2026-10-12，GAP-023 / #273 验收通过。前置 22 个节点与五项验收修复均已合入 main，生产代码基线为 `780a3b0e9cf6ee1f3377edd202fc8ebd9c1940f3`。最终交付的实际 PR、校验提交与 main SHA 记入本批 manifest，并可从 #273 的关联 PR 核对。

## 已核对的主应用

普通 App 的工作区、原始资料、定义/规则来源确认与人工审核、独立题集验核、包发布、项目映射、身份与字段审核、正式事实发布、数据集、注册规则任务及原文证据已接线。原始映射记录、实例审核记录和正式语义事实是不同步骤。

规则任务的适用性与业务命题分开表达；数据缺口、冲突、工具失败和取消也分别保留。来源读取重新核对授权原件、版本、字节摘要、行摘要和定位；结构化投影的完整映射按内容校验，JSON 字段顺序不改变其含义。

显式 Core profile 由服务端解析项目配置，主应用即使同时携带部署绑定，也不会改走预绑定创建入口。已发布版本、历史答案和执行绑定使用不可变引用。

## 验收证据

| 范围 | 代码与实际结果 | 边界 |
| --- | --- | --- |
| Node 22 精确提交 CI | [38127982055](https://github.com/Yijtu/ontology/actions/runs/38127982055)，提交 `a9c7406`：342 文件、3069/3069 测试通过；lint 与四套类型检查通过 | 合入 main `5c9abf4` 的完整树与验收树一致 |
| 最终全部浏览器回归 | 20 文件、99/99，通过 726.24 秒，无跳过；验收源 `10e1d735c96f5e47315d43b06367aacc64491bd6` | 与 main 生产代码一致；最终交付仅增加验收与文档，普通 Core 与内存宿主分别核对 |
| 界面、静态与默认回归 | 最新生产 CI 344 文件、3080/3080，lint 与四套类型检查通过；本地边界检查 8/8、最终 E2E 增量 lint/类型检查通过 | 最终交付 PR 的相同检查与合并记录可由 #273 关联 PR 核对 |
| 真实 App 视觉与可访问性 | 1440/1024/768/390/320 实际截图复看；原文 A2、焦点、标签、对比度与 reduced-motion 采样 | 具体采样，不是全站 WCAG 认证 |
| 1001 行与双行业、双查询后端 | 工业/交通 × DuckDB/独立 PostgreSQL 四种组合聚焦通过；普通 App 跨空间隔离通过 | 原生 1001 行完整、派生文本 1000 行截断如实标记；每页 25 条，仅末行人工批准并正式发布，原文定位 A1002，正式数据集 1 条 |
| 正常页面的版本演进、取消、重提取与历史 | 真实包 1.1.0 → 取消 → 重提取 → 字段/身份审核 → 发布 → 激活 → 撤回，聚焦 Flow1/3/4 三项通过 | 旧答案内容、执行绑定与原件摘要保持不变；语义发布作为独立不可变资源回读，不写回已固定的项目修订 |
| CLI 启动与 README 示例 | 实际启动、54 迁移、API/Vite/同源代理、两行 CSV/批准一行/A2、实际进程重启均通过 | 刷新修复 [#298](https://github.com/Yijtu/ontology/pull/298) 已合入 `d9ceace`；README 在全量验收通过后，最后基于实际 main Core 改写 |

导航测试中的一次故意无数据运行，按实际失败运行及唯一 `TypedDraftWriterError/INSUFFICIENT_DATA` 诊断记录识别；其他主宿主错误、只读宿主错误和关闭错误均不得忽略。测试创建的容器与命名卷按归属回收，既有环境不作清理。

### 实际启动中发现的刷新问题

真实 CLI 启动连续两次复现：页面后台重新读取相同记录和来源时，新的对象引用使事实候选提交被取消。数据库诊断显示无锁等待；页面刷新会清掉提交状态。提交 `9dac402` 改为按记录版本、项目修订、可见范围和原件/解析引用识别工作内容。等价刷新保留请求，实际切换仍取消请求并排除迟到结果。

新增回归先失败、修复后通过。独立审查补充了原件与解析引用的资源类型检查；最终 7 项新回归加 20 项相关界面检查通过。一次本机测试 fork 工作进程未启动，失败的那一套单独重跑通过，未修改超时。修复后的实际页面上传 2 条 CSV，仅批准并正式发布 1 条，保留 A2 原文定位；进程重启后的数据集快照摘要不变。此启动检查关闭模型和 JEV，使用独立容器、命名卷、端口、租户/空间与对象目录；自建进程、数据库卷和本地配置均已回收。

修复的[完整 CI 38136610173](https://github.com/Yijtu/ontology/actions/runs/38136610173) 为 343 文件、3076/3076 通过，lint 与四套类型检查通过。PR #298 校验提交 `9dac402` 与 main 合入 `d9ceace` 的完整树均为 `9c2819ec2a49c5e202d5268afc9784ed21939c71`。此补充 PR 归入 GAP-023，不增加任务节点或提前关闭 #273。


### 演进配置、取消后的来源与页面状态

正常页面验收还发现三处可复现问题，均按生产修复单独处理：

- [#299](https://github.com/Yijtu/ontology/pull/299)：前端漏传服务端要求的已解析目标配置。启动演进时准备真实已发布包配置，核对包、定义和快照摘要后提交。精确提交 `4bbd2fb` 的 [CI 38142066558](https://github.com/Yijtu/ontology/actions/runs/38142066558) 为 343 文件、3077 项通过。
- [#300](https://github.com/Yijtu/ontology/pull/300)：取消的目标映射产生较新物理记录，遮住仍有效的原项目记录。按当前项目修订固定的映射 ID/版本对筛选，再选择最新记录，保留原有摘要和来源守卫。真实 PostgreSQL 回归同时证明取消后可重提计划、同一有效映射的记录被修改仍会拒绝。提交 `6553c92` 的 [CI 38145348191](https://github.com/Yijtu/ontology/actions/runs/38145348191) 为 343 文件、3078 项通过。
- [#301](https://github.com/Yijtu/ontology/pull/301)：项目列表刷新临时卸载演进面板，重新挂载后读回已取消的旧计划。保留面板，沿用来源目录返回的项目行更新；跨写操作的迟到读取不能覆盖新计划。延迟旧读取回归在旧实现上失败、修复后通过，独立审查通过。提交 `a7e0bbf` 的 [CI 38150143727](https://github.com/Yijtu/ontology/actions/runs/38150143727) 为 344 文件、3079 项通过，lint 与四套类型检查通过；合入 `95c30f9` 的完整树为 `7a4d4ebdfd3e2b0fbc29a35993eddf8c653d47f5`，与校验提交一致。首轮 CI 仅遇到镜像仓库限流，原提交重跑通过。

首次完整浏览器运行完成 20 文件、99 项，其中 96 项通过。Flow1 在已有工作区初始加载完成前打开新建表单，随后表单收起，连带 Flow3/4 的前置资料不存在。补齐普通页面的加载与披露状态等待后，第二轮在上下文同步检查处仍失败，已中止且不计为完整通过。随后整份 Generic 流程的实际 DOM 记录确认产品问题：本体面板局部选中已有工作区，但顶部选择与 URL 仍为空。无 URL 参数时 null 未归一化为 undefined，使初始化同步分支不执行；新增真实 App 回归已复现此缺陷，最小修复 [#302](https://github.com/Yijtu/ontology/pull/302) 已合入 `780a3b0`。旧实现的真实 App 回归失败，修复后初始化与显式切换 2/2 通过；提交 `1414b46` 的 [CI 38152192490](https://github.com/Yijtu/ontology/actions/runs/38152192490) 为 344 文件、3080 项通过，lint 与四套类型检查通过，完整树 `8e0f1db66795532569bc71aa869edb2d9497e3dd` 与 main 一致。整份 Generic 流程最终 14/14 通过（129.07 秒）；审核页跳转保留实际项目上下文，完整历史与来源断言不变。最终全量 20 文件、99/99 于 2026-10-12 通过（726.24 秒），无跳过。前面的失败和中止运行均保留，未计入通过结果。最终新增代码已独立复审；仅观察到框架故意无资料运行的一次预期错误，其他工作与关闭诊断为空。

## 支持范围与外部条件

- 本批使用合成行业与独立编写的预期；受控 provider 只替代生成模型的 HTTP 边界。通过这些用例不代表真实模型或客户质量。
- 原生结构化解析和派生检索文本有各自上限；截断不能冒充完整，未批准候选不能进入正式查询数据集。
- 默认模型关闭；外部生成模型、JEV 和生产认证需另行配置及验收。客户 StarRocks、Iceberg、Milvus、DataOS 接入与实机效果不由本批合成验收证明。
- #169 保持打开；未启动 B 阶段。旧工作区、manifest 与历史记录保留。

## 迁移

当前 `platform/migrations/control` 有 54 个 SQL 迁移。本批相对基线 `43525be` 新增 8 个：`078_pack_review_content_pins`、`079_exact_scalar_decimals`、`080_published_rule_dependencies`、`081_definition_generation_reuse`、`082_rule_action_generation`、`083_project_evolution`、`086_structured_parse_selection`、`087_optional_table_verification_receipt`。编号空缺不补造迁移；历史运行过的 25/28 个迁移不代表当前数量。

## 已合入账本

下表由已合入 PR 的实际元数据核对。第 23 项最终交付 PR、完整提交与实际 main SHA 随交付写入本批 manifest；#273 关联 PR 可回查最终自动检查。
| 节点 | Issue | PR | 校验提交 | main 合入 |
| --- | --- | --- | --- | --- |
| 1 | #251 | [#275](https://github.com/Yijtu/ontology/pull/275) | 834f666 | 89401c0 |
| 2 | #252 | [#277](https://github.com/Yijtu/ontology/pull/277) | 8e78489 | 8dba70c |
| 3 | #253 | [#280](https://github.com/Yijtu/ontology/pull/280) | 4dcf1b4 | 7936670 |
| 4 | #254 | [#279](https://github.com/Yijtu/ontology/pull/279) | 7a3cbf0 | 4394452 |
| 5 | #255 | [#281](https://github.com/Yijtu/ontology/pull/281) | bcc24e1 | 9198fb3 |
| 6 | #256 | [#284](https://github.com/Yijtu/ontology/pull/284) | 72c799c | 2744e07 |
| 7 | #257 | [#287](https://github.com/Yijtu/ontology/pull/287) | 8bacf04 | 053eb11 |
| 8 | #258 | [#288](https://github.com/Yijtu/ontology/pull/288) | b54bee8 | a392ed8 |
| 9 | #259 | [#282](https://github.com/Yijtu/ontology/pull/282) | a8c6856 | f116fff |
| 10 | #260 | [#283](https://github.com/Yijtu/ontology/pull/283) | ea68b56 | d853d59 |
| 11 | #261 | [#286](https://github.com/Yijtu/ontology/pull/286) | 6e175af | 06e9aee |
| 12 | #262 | [#285](https://github.com/Yijtu/ontology/pull/285) | db7b4b0 | 8b4aa3c |
| 13 | #263 | [#290](https://github.com/Yijtu/ontology/pull/290) | ed53423 | dc26584 |
| 14 | #264 | [#289](https://github.com/Yijtu/ontology/pull/289) | 3db4757 | d0b4066 |
| 15 | #265 | [#292](https://github.com/Yijtu/ontology/pull/292) | c2836ef | 25794b6 |
| 16 | #266 | [#293](https://github.com/Yijtu/ontology/pull/293) | deeb38e | 323cb9d |
| 17 | #267 | [#278](https://github.com/Yijtu/ontology/pull/278) | 5610a86 | 3c5967e |
| 18 | #268 | [#291](https://github.com/Yijtu/ontology/pull/291) | 61813d0 | 6507481 |
| 19 | #269 | [#296](https://github.com/Yijtu/ontology/pull/296) | 16187b9 | d373cc7 |
| 20 | #270 | [#294](https://github.com/Yijtu/ontology/pull/294) | 2e57b16 | 0b50e05 |
| 21 | #271 | [#295](https://github.com/Yijtu/ontology/pull/295) | dd9afe4 | 10207bb |
| 22 | #272 | [#297](https://github.com/Yijtu/ontology/pull/297) | a9c7406 | 5c9abf4 |
