# 代码审查与修复清单

> 后续状态提醒（2026-09-23）：LOCAL-072 / 2d7a7f2 已新增公司模型 OpenAI 兼容 codec。下文保留原审查发现；R13 当前应核查新适配路径与最新验证，不原样重复修复。最新交接见 [HANDOFF.md](../../HANDOFF.md)。

日期：2026-09-23。基线：`527a79c5d844c222b03a7442fd3beffaed5741be`。范围：当前 `platform/` 实现，重点沿 HTTP 问答、控制器、答案核验、本体规则、物化、模型适配和场景装配检查；不是仅审查最后一个提交。

审查期间仓库新增 `bd60168`（LOCAL-051）。已补查该提交的 9 个文件，增量范围固定到此提交；它新增环境密钥解析与真实模型验证脚本/报告，未修改下列既有缺陷路径。报告中的真实调用结论作为已提交的外部验证记录引用，本轮没有重放付费调用。

本轮按 review-it 的副作用、边界、隔离、性能、测试与维护性维度人工追踪代码，并运行现有检查和独立诊断。用户要求给出修复清单，因此未自动修复、提交或关闭任务。原有 `issue-048-semantic-regression-fixtures.md` 的未提交改动原样保留。

## 结论

已有可复用的契约、预算账本、工具网关、数据适配、解析、审核、规则与能源计算模块，但当前还不能按“用户从正式 HTTP 入口提问，自动获得可阅读、可信、可恢复的业务回答”交付。测试通过证明已覆盖路径可以运行，未覆盖的装配与语义错误仍然存在。

确认 13 项需要修复：11 项 P1（业务交付前解决），2 项 P2。没有确认 P0。本轮为按风险选取主链路的仓库审查，并非对全部源码逐行穷尽验证。

| ID | 优先级 | 需要修复 | 直接后果 |
|---|---|---|---|
| R01 | P1 | HTTP 命令没有进入工作流控制器 | 提问停在 created；澄清、恢复和取消缺少执行侧衔接 |
| R02 | P1 | 最终答案缺少正文生成、持久化与读取闭环 | 成功后用户只能看到 ID、哈希等元数据 |
| R03 | P1 | 规则编译忽略例外条件 | 本应不适用的规则仍得出确定结论 |
| R04 | P1 | 规则前提没有按实体绑定 | A、B 两个对象的事实被拼成一个满足条件的对象 |
| R05 | P1 | 物化来源只取前 1,000 条，未标记不完整 | 数据增长后漏事实、漏规则、漏依赖 |
| R06 | P1 | 回答正文没有与已核验 claims 绑定 | 正确 claim 搭配错误正文仍可通过 |
| R07 | P1 | 时间声明可绕过证据绑定 | 删除 timePointer 后任意 asOf 都可通过 |
| R08 | P1 | Jev HTTP 协议与官方接口不符 | 填入官方地址和密钥仍无法正常请求、解码 |
| R09 | P1 | 语义核验只传 ID/hash，未提供待判内容 | 决策模型看不到实际 claim 和证据 |
| R10 | P1 | 工作流清单与核验记录缺少持久化适配 | 重启/跨进程恢复丢失控制器所需状态 |
| R11 | P2 | 控制器忽略 createRun 返回的幂等 runId | 同键重试传入新 ID 时返回 RUN_NOT_FOUND |
| R12 | P2 | 端到端验收替身掩盖关键断链 | 报告“全链路通过”不能证明真实入口完成回答 |
| R13 | P1 | 公司模型流解码与已验证网关协议不符 | 原始请求成功，平台 GenerationPort 仍然无法使用 |

## 逐项依据、修复边界与回归条件

### R01 — HTTP 请求只创建记录，没有调度工作流

位置：[server.ts:97](../../platform/apps/api/src/http/server.ts#L97)、[RunService.createRun](../../platform/packages/application/src/runs/service.ts#L184)、[控制器入口](../../platform/packages/application/src/workflow/controller.ts#L82)。

`POST /runs` 调用 `RunService.createRun` 后返回 202。该方法保存 run 和公开事件，没有提交工作流执行任务。API 依赖中没有工作流命令入口；现有 Worker 也没有消费 run 执行的路径。responses/resume/cancel 同样直接调用 RunService，未调用控制器对应行为。

**复现**：调用真实 Fastify 路由和 RunService，GET 显示 `created`，注入 runtime 的启动次数为 0。验收环境通过测试函数直接调用 `controller.startRun`，因此不会发现断链。

**修复**：增加通用工作流命令/调度端口，由宿主把 HTTP 命令接入控制器或可靠任务队列；202 返回前持久化调度意图。保持 controller 拥有阶段切换，runtime 拥有收证循环；不要在 HTTP handler 再复制规划循环。

**回归**：仅通过 HTTP 创建并等待真实本地 Worker，即可获得终态及正文；重复请求不重复执行；澄清可继续、取消能触发实际运行的中止、恢复保持同一预算。

### R02 — 最终答案只有元数据

位置：[PublishedAnswer](../../platform/packages/contracts/src/workflow.ts#L211)、[答案存储](../../platform/packages/adapters/control-postgres/src/answer-store.ts)、[答案 API](../../platform/apps/api/src/http/answers.ts#L47)、[AnswerPanel](../../platform/apps/web/src/components/QueryPanel.tsx#L193)、[RestrictedDraftWriter](../../platform/packages/application/src/workflow/restricted.ts#L39)。

`PublishedAnswer` 只有 ID、内容哈希、证据哈希、发布类型等，没有正文或可读取的内容引用；数据库也只保存这些元数据，API 原样返回，UI 展示相同字段。当前源码中的常规 DraftWriter 只有 restricted 实现，生成问题与证据数量摘要，未构成从证据回答业务问题的生成器。

**复现**：控制器运行到 published 后，结果没有 `blocks` 或 `contentRef`。这不能靠增加 UI 文案修好。

**修复**：实现通过 GenerationPort 或确定模板生成结构化回答的 DraftWriter；将精确的已核验内容作为不可变 artifact 保存；PublishedAnswer 引用该内容，读取 API 按权限返回，UI 渲染该版本及证据链接。不要在核验后重新生成一份正文。

**回归**：公开 API 返回可读业务答案；显示内容的 hash 与核验记录一致；重启后可读；篡改正文被拒绝；无证据时展示明确缺口。

### R03 — 规则 exceptions 被静默丢弃

位置：[compile.ts:19](../../platform/packages/semantic-engine/src/rules/compile.ts#L19)、[RuleExceptionNode 的明确语义](../../platform/packages/contracts/src/rule-extraction.ts#L87)。

契约规定规则的含义为条件成立且例外不成立。`supportRuleFromPublishedRule` 只编译 `rule.expression`，没有处理或拒绝非空 `rule.exceptions`。与显式 `not` 被拒绝不同，带例外的规则在这里被扩大了适用范围。

**复现**：`enabled=true` 且 `maintenance=true`，规则“启用可用，但维护时例外”仍输出 `known/true`。

**修复**：先在编译入口对无法表达的例外返回明确 unsupported；需要支持时按确定、声明完整性的例外语义编译。例外不可降级为注释。

**回归**：例外成立、未成立、未知、冲突均有独立预期；例外与正文分片也不得丢失。

### R04 — 同类型不同实体的事实被拼接

位置：[alternativesFor](../../platform/packages/semantic-engine/src/rules/compile.ts#L37)、[结论构造](../../platform/packages/semantic-engine/src/rules/compile.ts#L30)。

前提候选仅按 `fact.predicate === attributeId` 选取，忽略 subject。规则结论又只使用类型级 `objectId`。当一条对象规则要求同一电池同时满足 A、B，来源却分别属于两个电池时，也会得到真值。

**复现**：battery-A 只有 enabled=true，battery-B 只有 islanding=true；`all(enabled,islanding)` 输出 `known/true`，没有一个实际电池同时具备两条已知事实。

**修复**：在规则实例化/编译层显式绑定实体变量、属性所属对象和必要关系；前提按同一 binding 求值，结论标识包含绑定与时间。跨对象组合必须由关系语义声明；不能把整个租户的同名属性当替代来源。

**回归**：双实体、同名属性、关系连接、不同单位/有效期、同对象多来源分别验证；不存在足够事实的实体保持 unknown。

### R05 — 物化只读取首批数据

位置：[PublishedSemanticSource.load](../../platform/packages/semantic-engine/src/materialization/published-source.ts#L58)、[PostgreSQL LIMIT](../../platform/packages/adapters/control-postgres/src/semantic-publication-store.ts#L667)、[读取契约](../../platform/packages/contracts/src/semantic-publication.ts#L267)。

默认各读一次 `listStatements({limit:1000})`、`listRuleVersions({limit:1000})`。契约无游标，结果无完整性信息，load 直接返回 facts/rules/entityBindings。规则版本只在截断后的集合里去重，后续更新甚至可能不在集合内。溯源支撑读取使用相近的有界首批模式，修复时应一并审查。

**复现**：模拟与真实存储 LIMIT 一致的受限 read view，提供 1,001 条，load 只返回 1,000 条、只请求一次，并没有 coverage/truncation 字段。SQL 路径确认有相同 LIMIT；本轮没有创建 1,001 行真实数据库来重复此测试。

**修复**：为读取增加稳定快照与游标，按受影响依赖分批读取；达到预算时保持不完整/待继续状态。不可通过取消 LIMIT 或无限增大 pageSize 解决扩展性。

**回归**：跨页事实、跨页新规则版本、读取中发生更新、超预算恢复；全量结果与增量结果一致，截断结果不得标为完整。

### R06 — 验证 claims，却允许任意正文

位置：[DraftVerificationService.verify](../../platform/packages/application/src/verification/service.ts#L105)、[AnswerDraft blocks](../../platform/packages/contracts/src/workflow.ts)。

正文参与 hash，但 hash 只证明内容一致，不证明正文由 claims 支持。核验器只检查声明出来的 claims，没有检查 blocks 的每个断言是否与之绑定。可保留正确 claim，同时在 blocks 填入相矛盾的结论。

**复现**：证据和 claim 均为 12.5 kWh，正文写 9999 kWh；重新计算合法 hash 后，默认核验返回 pass 且 failedChecks 为空。

**修复**：定义可渲染的受控 block schema，通过 claimId 引用业务数值与语义；程序检查所有可见断言覆盖率。必要的自由文本核验也须拿到正文和证据，不能仅比较哈希。

**回归**：正确正文通过；多写、少绑、换单位、错误结论和正文/claim 矛盾均被定位拒绝。

### R07 — 有时间声明但没有 timePointer 时不校验

位置：[hard-checks.ts:152](../../platform/packages/application/src/verification/hard-checks.ts#L152)、[ClaimTimeBinding/ClaimResultBinding](../../platform/packages/contracts/src/verification.ts#L40)。

代码只在 `binding.timePointer` 与 `claim.time.asOf` 同时存在时比较时间；两个字段均可选。声明一个 asOf 后删掉 timePointer，硬检查会跳过。validFrom/validTo 也需要明确的绑定规则。

**复现**：证据日期为 2026-09-20，claim 改为 2099-01-01 并省略 timePointer，仍返回 pass。

**修复**：声明了业务时间就必须具备与之相符的可验证绑定；明确无时间声明、瞬时值、区间值的联合契约，缺失绑定返回 failure/unknown。

**回归**：缺指针、指针无值、不同 asOf、区间错位、未来有效期和历史读取分别测试。

### R08 — Jev 外部协议不匹配

位置：[默认 endpoint](../../platform/packages/adapters/model-jev/src/http-client.ts#L34)、[wire 请求](../../platform/packages/adapters/model-jev/src/vendor/jev-wire.ts#L108)、同文件 response decoder。

当前代码默认请求 `/v1/decide`，发送 `state_ref`、questions 数组及 prompt/options；解码期待 model_version/results。2026-09-23 查询的官方接口为 `/v1/systemone`，请求使用实际 state 与 questions 映射，问题使用 instructions/criteria，响应为 model/answers。即使覆盖 endpoint，body 与 decoder 仍不兼容。[官方 API](https://docs.typesafe.ai/api)

**复现**：本地 fetch 替身记录上述路径与字段；官方形状的 Noul 响应被本地 decoder 拒绝为 malformed。没有发送外部请求。

**修复**：在 model-jev 适配器内对齐当前官方协议或 SDK；保留平台 DecisionPort 的稳定接口。内部 optionSetHash、版本与审计引用由本地维护，不能假设供应商返回同名字段。

**回归**：依据官方协议独立编写服务替身，覆盖 Choice/Score/Noul、错误与缺字段，再在另行具备资源的真实集成任务中测试；不能只让测试服务器复刻当前错误协议。

### R09 — 语义核验没有传入实际内容

位置：[buildSemanticQuestion](../../platform/packages/application/src/verification/decision-review.ts#L36)、[调用 DecisionPort](../../platform/packages/application/src/verification/service.ts#L253)。

问题只有“这个 claim UUID 是否得到证据支持”；stateRef 只有 hash 等引用，调用链中没有加载引用并传入 claim/证据的 resolver。真实模型无法从本地 hash 推导源内容。这里与 R08 独立：协议修正后仍需补足内容。

**复现**：捕获决策端口输入，不含 claim 的 subject、12.5 的值或来源内容。[官方 state 说明](https://docs.typesafe.ai/concepts/state)要求提供待判断材料。

**修复**：经授权读取、裁剪并传入问题、结构化 claim、对应证据和必要上下文，记录所用内容摘要；按信息不足策略处理，保持大小与预算上限。

**回归**：真实内容变换能改变模型输入；其他实体同数值、预测冒充观测、无关证据、缺上下文可被识别；不以任意总是 supported 的替身证明质量。

### R10 — 恢复所需数据仍只在内存

位置：[InMemoryWorkflowStore](../../platform/packages/application/src/workflow/store.ts#L29)、[InMemoryVerificationStore](../../platform/packages/application/src/workflow/restricted.ts#L133)、[验收装配](../../platform/tests/e2e/acceptance/acceptance-environment.ts#L676)。

runs、runtime checkpoints 与 answer_publications 有 PostgreSQL 实现，但控制器需要的 RunManifest、WorkflowInputManifest、WorkflowRunState 和 VerificationStorePort 只发现内存实现。SQL migration 没有对应持久化绑定；已有 checkpoint 不足以重建这些数据。验收也使用这些内存对象。

**修复**：在 control-postgres 补齐端口实现、作用域、版本/并发语义和原子状态推进，正式装配不能默认选择内存替身。允许测试继续显式使用内存实现。

**回归**：创建与暂停后关闭进程，另一个进程从存储恢复同一清单、预算及核验记录；租户隔离、重复投递、核验中断和取消重启均可验证。

### R11 — 幂等返回的 runId 未被使用

位置：[WorkflowController.startRun:82](../../platform/packages/application/src/workflow/controller.ts#L82)、[RunService 幂等返回](../../platform/packages/application/src/runs/service.ts#L207)。

RunService 对同键同内容正确返回已有 runId；controller 忽略该返回值，后续继续按 input.runId 查清单和 run。请求端每次生成新 UUID 的常见重试因此失败。

**复现**：首次 published 后，以相同业务 payload 与 idempotencyKey、不同 runId 再调用，得到 RUN_NOT_FOUND。

**修复**：使用 createRun 的规范 runId 继续处理，并显式保证可信 context 与其一致；重复启动不得打开新预算或重跑已完成运行。

**回归**：同键同 ID、同键不同 ID、同键不同内容和并发同键请求，分别断言复用或 409。

### R12 — 验收报告高估了实际端到端覆盖

位置：[浏览器验收直接 seedAnswer](../../platform/tests/e2e/acceptance/acceptance.browser.e2e.ts#L110)、[验收环境 Restricted 服务](../../platform/tests/e2e/acceptance/acceptance-environment.ts#L750)、[交付报告](../../platform/docs/local-054-delivery-report.md)。

浏览器先提交问题，再额外 seed 另一个 run 的“已发布答案”来检查显示；非浏览器验收从测试函数启动 controller，使用 RestrictedDraftWriter/RestrictedAnswerVerifier、StaticInputValidity 以及部分 scripted 工具。单独测试正式核验器有价值，但不能证明同一 HTTP 问题走完整条链路。

**修复**：保留组件测试；补一条只替换外部模型传输/数据提供方、其余使用正式装配的旅程，禁止 seed 发布结果或手动推进状态。报告逐项列明替身边界。

**回归**：浏览器发起问题，等待同一个 run 的真实工具结果、正式核验与可读答案；至少一次异常和重启恢复沿同一装配验证。

### R13 — 公司生成模型适配器不识别实际网关流

位置：[decodeCompanyWireChunk](../../platform/packages/adapters/model-company/src/vendor/company-wire.ts#L100)、[新增真实验证报告](../../platform/docs/live-model-validation.md)。

增量提交的报告记录公司网关返回 `chat.completion.chunk`/choices.delta：原始自然语言、JSON、工具调用探针成功，但平台 GenerationPort 被协议问题阻断。当前 decoder 只识别自定义 type=text_delta/tool_call_delta/usage/completed 事件，真实网关 chunk 返回 undefined。

**复现**：将该网关形状的本地合成 chunk 交给真实 decoder，得到 undefined。实际外部网关行为依据上述已提交报告，本轮没有重新连接。

**修复**：由 model-company 适配器正确映射该网关 SSE、工具调用 ID/增量参数、结束原因、model/usage 与错误；平台 GenerationPort 保持稳定。真实网关的 call ID 不应被直接误当平台 UUID。

**回归**：依据真实协议固定脱敏 fixture，检查自然语言、JSON、交错工具流、缺 usage/异常结束与取消。用 GenerationPort 完成同一组真实验收后才能从“端点可达”升级为“平台可用”。

## 本轮验证证据

| 验证 | 结果 | 能说明什么 |
|---|---|---|
| `pnpm run lint` | 通过 | 当前 lint 规则通过 |
| `pnpm run typecheck` | 通过 | 主工程、Web、acceptance 三套 TS 配置通过 |
| `pnpm exec vitest run --project unit --project architecture --maxWorkers 4` | 88 文件、1,162 测试通过 | 已有单元、契约、UI 状态和架构覆盖 |
| `pnpm run test:acceptance` | 3 文件、26 测试通过 | 现有跨层测试，具有 R12 所述替身边界 |
| `pnpm run build:web` | 通过 | Web 可构建 |
| `pnpm run test:e2e` | 6 文件、25 测试通过 | 现有浏览器旅程可运行，不代表 R01/R02 已解决 |
| `bd60168` 增量相关测试 | 3 文件、35 测试通过 | secret-resolver、live-report 与受影响的 source-registry；只用本地替身 |
| 独立诊断 | 11 个复现场景得到预期的错误表现 | 见下方脚本和 JSON |

原基线运行既有 1,213 项测试；新增提交另外运行 35 项相关测试，并复查 lint/typecheck。增量测试包含已测用例，不将两次数量包装成去重覆盖率。没有重跑全部 integration/composition/load 项目，没有调用真实 LLM/Jev 或连接 HA 设备。不能据此宣称全库无其他缺陷、已完成性能验收或生产部署。

- [复现脚本](2026-09-23/reproduce.mts)：在 `platform/` 执行 `pnpm exec tsx ../docs/reviews/2026-09-23/reproduce.mts`。脚本断言的是当前缺陷，修好后相应断言应失败；它不是新的通过标准。
- [本次诊断结果](2026-09-23/reproduce-results.json)：HTTP、答案元数据、幂等、正文、时间、JEV 输入/协议、规则例外、跨实体、首批截断、公司模型协议。

## 修复顺序与边界

1. 固定复现与负例，修 R03—R09、R13 的正确性/协议问题；暂不支持的规则条件显式拒绝。
2. 一并完成 R01/R02/R10：可启动的正式宿主、调度、持久化、DraftWriter 和正文读写；接入时同时修 R11。
3. 按[场景解耦方案](../scenario-decoupling-2026-09-23.md)抽出应用场景装配。不要在新接线中再次硬编码 home-energy。
4. 完成 R12 的真实入口旅程，增加第二场景替换验收；再进入真实模型/设备与容量评测。

单独保留为能力边界而非新增缺陷：HA、S3、向量检索和实机操作当前明确未实现；缺少这些组件不能被算成回归。NL2SQL 标准流水线已有 LOCAL-071 跟踪，本轮在逆向规格中记录其实际覆盖，不重复伪造新 GitHub Issue。模块化单体与本地工具调用本身也不构成解耦问题。
