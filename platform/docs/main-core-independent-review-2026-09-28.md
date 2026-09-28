# main Core 独立验证记录（进行中）

本轮基线：`main@51c8cb4`；实施分支：`feat/main-core-product-20260928`。本文件记录根代理的独立复核，不代替实施 SPEC 的最终验收矩阵。

最新代码检查点为 `f1e362d`：Planner 的 JEV 实际状态归档与失败分类；`444bdb5` 是真实 PostgreSQL 支撑定位和来源 UI，`b4c9164` 是启动器模型角色隔离，`6a20318` 是模型端口工厂和抽取计费边界。`5a0fb80` 已交付可用工作台、导入/审核/事实查询/来源 UI 和配置版本接线。正常原始导入至事实答案、浏览器配置激活和同回答/证据的进程重启读取已独立通过。正常规则回答、模型宿主规划与完整矩阵继续实现；下面的模块测试不代表整个产品已交付。

## 已独立验证的检查点

| 范围 | 独立执行结果 | 实际覆盖及限制 |
| --- | --- | --- |
| 规则属性投影与实例纯核 | 3 文件 / 48 项通过 | 校验实体/对象/定义范围、值/单位与规则适用性；尚不代表生产 outbox 链通过 |
| JEV adapter、budget、layering | 3 文件 / 60 项通过 | 受控 HTTP System One 请求、实际 state 和概率语义；未调用真实付费网关 |
| C1 修订后的正文核验、答案发布、Controller、API、feedback | 5 文件 / 64 项通过 | V2 正文 hash/typed assertions、旧 V1 限制、限制码与时间绑定；不是宿主重启或多进程验收 |
| 身份裁决和 PostgreSQL identity store | 2 文件 / 23 项通过 | 包含 9 项真实 PostgreSQL 集成；强键审核、实体 revision CAS、身份读取 revision 与 scope |
| prepare 配置 | Vitest 1 文件 / 3 项通过 | 单独 app DSN、端口、数据库、scope 配置约束 |
| dev launcher 配置与占用端口 | Node test 4 项通过；Node syntax check 通过 | 禁用/启用模型的后端变量、Vite 变量白名单、缺入口、已占用端口 |
| prepare 实际 PostgreSQL | 首跑 25 migrations applied；重复执行 0 applied / 25 current | 临时命名卷、临时 `ontology_core` 库、随机端口；应用账号非 superuser、NOBYPASSRLS，未设置 scope 时 tenant 查询返回 0 |
| 持久 dispatch store | 2 文件 / 6 项通过，包含真实 PG 4 项 | 新迁移 054、RLS、幂等逻辑动作、两个 owner 竞争、租约过期/接管、旧 fence 拒绝、取消、digest 校验；未验证 host 恢复/实际发布 fencing |
| 本体源读取与结论绑定 | 2 文件 / 7 项通过 | 多 publication 同 schema、空属性未知、身份不完整、规则不适用时业务 unknown、同对象类型/枚举/单位及精确数量；尚非 PG/outbox/query 闭环 |
| JEV actual-state composition 和本地 blob | 2 文件 / 30 项通过 | 包含 resolver 11、blob 19 项；本 run/profile/ref authorizer、metadata-only 前置大小校验、跨 run 拒绝、字节/JSON/record cap/digest；尚非宿主正常运行时登记/重启验收 |
| C2 新规则实例和物化护栏小检查点 | 2 单元文件 / 27 项通过；架构 1 文件 / 8 项通过 | 1,001 实例的属性分组、单实体 parent 失效、identity/rule fanout、实体 qualified key 和物化/按需一致、开放 fence 下已存历史切片；该千条测试为内存单元，不是实际 PG 全链规模验收 |
| 通用已发布正文叶子组件 | jsdom 1 文件 / 9 项通过 | 精确数量/false、quote 转义、拒绝自由 prose 和失配 block、缺引用、非业务规则状态、历史/legacy；尚未接入 QueryPanel 或正常 API/browser 业务流 |
| C2 事件消费者加入后的单元检查点 | 3 文件 / 34 项通过，6.88s，exit 0 | 包含上面的 27 项及消费者新分页、split fence 复用等；不与前表重复相加；真实 PostgreSQL 属性链仍待独立复跑 |
| C2 物化及身份 fence PostgreSQL 独立复跑 | 4 文件 / 14 项通过，48.07s，exit 0 | 物化三组 5 项 + identity 9 项；千条属性投影、OR/例外/最后支撑撤回 unknown、并发 slice 重读、幂等 generation、split fence/read-head/outbox 同事务及回滚；模块夹具，不代替最终正常原始导入 E2E |
| C3 已发布事实 → ontology lookup | 2 文件 / 6 项通过，15.37s，exit 0 | provider 单元 4 + PG 2；千条事实跨 200 行页面、真实 LookupService/Handler、current/retract/future/expiry、重试与并发独立扫描、revision 变化和历史拒绝；PG 在 publication adapter 边界播种，不代替正常导入流程 |
| C2/C3 综合聚焦单元 | 7 文件 / 93 项通过，9.26s，exit 0 | C2/事实读取桥六单元 60 + Verifier 33；state 原问题/硬读证据、受控 HTTP JEV、多 claim/重试/repair 同 ledger 六请求六 reservation、取消/归档/结算 fatal 传播、completed/not_run；不与旧检查点相加 |
| C3 dispatch/Controller/worker 与实际 HTTP/PG | 4 文件 / 24 项通过，24.23s，exit 0 | 包含真实 PG 7 项；正常 Fastify POST 创建 canonical run 并入唯一 initial dispatch、请求重试、cancelRun、失租/过期 attempt 发布拒绝、当前 lease 发布，Controller 持久恢复与 worker 续租/abort；尚非原始导入到最终问答的宿主全链 |
| 工作台新 profile 发布和现有交互 | jsdom 2 文件 / 17 项通过，15.13s，exit 0 | 新版本发布后才对同一新 ref preflight/activate；缺 mapping 或不可兼容组合阻断；尚非默认宿主 browser E2E |
| QueryPanel 与 App 场景接线 | jsdom 2 文件 / 17 项通过，13.53s，exit 0 | 正文组件和来源交互、既有页面行为；尚未验证新增部署元数据及两行业页面挂载 |
| 严格已发布事实绑定、默认事实正文与行业原始资产 | 3 文件 / 11 项通过，2.51s，exit 0 | strict fact 字段 4、draft 2、assets 5；真实本地 parser/native ExtractionPipeline 产待审候选，政策为受控模型响应；mapping/schema/摘要及 6000/5999 分钟阈值检查，未宣称实际数据适配器转换或正常发布已通过 |
| 新模块加入后的全 unit/contracts/UI 项目 | 115 文件中 114 通过；1,381 项中 1,380 通过，45.08s，exit 1 | 唯一失败为 semantic-provenance 的实际支撑来源正例，已分配修复；不是全量回归通过。单独 architecture 1 文件 / 8 项通过；全 lint 发现同一 source 单测的 8 个未使用参数，待修复 |
| 056 实际 PostgreSQL 状态引用授权 | 1 文件 / 3 项通过，10.40s，exit 0 | 非 superuser/NOBYPASSRLS 的应用角色、RunService 正常创建 run、scope/run/profile/fullRef、幂等/冲突、取消后拒绝、无 scope 看不到行、`{}` 触发 SQLSTATE 23514；没有模型调用或预置答案 |
| 修订后的支撑来源模块 | 单元与架构 2 文件 / 16 项通过；根 evidenceRef/payloadRef 接口修订后单元 8 项通过 | reader 必须提供不可变、唯一实例与真实 premise group；缺 reader、模糊、未知或冲突不再用当前 publication 头补来源。模块 reader 为夹具，正式 reader 尚未接入 |
| 支撑来源原有 PostgreSQL/HTTP 正例回归 | 2 文件 / 8 项中 4 通过、4 失败，24.45s，exit 1 | 默认 composition 尚未注入 immutable reader，premiseGroups 为空、原分页/truncation 正例失败。保留正例，须补真实归档 reader 与完整性状态；未标最终来源链完成 |
| 行业 loader 直接调用 | 两行业各 3 raw sources、2 physical mappings 成功读取 | 首次调用发现 policy 被错误要求属于 rawSources，已修正独立 policy 字段；只验证加载，未 seed、未执行数据库 mapping、未启动完整宿主 |
| 行业 loader 完整边界模块复核 | loader + assets 2 文件 / 7 项通过，3.20s，exit 0；两个 loader 文件 ESLint 通过 | 默认 index、trusted scope 重绑定、exact refs/mapping 与路径越界；owner 全平台 TypeScript 通过。完整启动/注册/数据查询不属于 loader 的完成范围 |
| 新来源完整性消费边界 | 4 文件 / 30 项通过，4.26s，exit 0；5 个来源相关文件 ESLint 通过 | 22 来源单元 + 8 架构；未知/冲突/缺 reader、depth 0/边界、缺节点和续页保守传播。来源模块仍未接正式 immutable reader，不能以此替代旧 PG 正例 |
| 真实业务数据快照与 SQL NULL | snapshot 1 文件 / 4 项通过，7.53s；相关 mapping 3 文件 / 26 项通过，13.06s | 真实 DuckDB/DataQueryHandler，四 mapping、运输独立来源、6000/5999 分钟边界及缺失值；修复 schema 初始化和 unknown→BOOLEAN 转换。没有预置语义中间态 |
| 首条正常 HTTP 纵向链 | 独立首跑 1 文件 / 2 项通过，17.53s | 命名卷真实 PG、应用角色、真实 HTTP listen；raw import→parser/worker→native candidate→create_pending+match→approve→publish→真实 fact lookup→V2 false 断言→hard verifier→严格 lease-fenced AnswerStore。另一项拒绝未知自然语言任务 |
| 两行业 HTTP 与 dispatch 再复核 | 2 文件 / 12 项通过，32.06s，exit 0 | HTTP 3 项含运输两来源和工业 canonical 100 h；dispatch PG 9 项。原始资料经同一正常 API 链，不 seed candidate/identity/statement/answer。尚非完整规则推理、浏览器或实机/真实模型验收 |
| 新部署 UI 与可信 ProfileSpec 初次独立检查 | 4 文件 / 6 项通过，4.60s；正常 HTTP 1 文件 / 3 项通过，27.57s | 场景描述、导入表单与工作台挂载的聚焦验证；没有覆盖真实默认首页所需的所有后端 route |
| UI 加入后的完整 unit/architecture 检查 | 122 文件中 116 通过、6 失败；1,348 项通过，74.49s，exit 1 | 六个 UI suite 在导入阶段被 loader 的 Node 默认路径初始化阻断，不能记为全量通过 |
| loader 导入回归修复独立复核 | 原六个 UI suite + loader + jsdom 导入回归，共 8 文件 / 64 项通过，29.85s，exit 0 | 默认路径改为调用时解析，并使用 node:url.URL；保留原 UI 测试与全部断言，Node 默认资产加载继续通过 |
| 新 UI 阶段 lint/typecheck | 完整 ESLint 和 platform/Web/acceptance 三个 TypeScript 项目通过 | 后续生产路由、模型与来源改动完成后仍须按受影响范围复核 |
| 实际 subprocess launcher 与浏览器初查 | 临时库首跑 28 migrations；修复 Vite root/proxy 后 API/Web 就绪，metadata 经同源代理返回 200 | 原实现 API 健康但 Web readiness 超时；已分配并修复配置。浏览器正常导入 T-04 → worker 待审 → pending+match → approve → publish 通过。默认 Workbench 缺 route 返回 404，QueryPanel 缺 scope projection 返回 CAPABILITY_NOT_CONFIGURED，继续修复，未标浏览器闭环完成 |
| 正式不可变支撑 reader 独立检查（09-29） | 5 文件 / 35 项通过，4.44s，exit 0 | reader 5 + producer/consumer 22 + architecture 8；真实工件定位、完整证据引用、授权元数据先查、1 MiB 上限与精确 UTC 区间。PG 正例与正常 rule producer 仍待完成 |
| 配置与页面路由的正常 HTTP 检查（09-29） | 1 文件 / 4 项通过，24.08s；UI 4 文件 / 6 项通过，4.95s | Workbench 路由、scope projection、新版激活后立即 metadata 刷新、两个行业的事实链与新版本重启查询。之后加入的同旧 run/body/evidence 重启比较还需独立复跑 |
| 修复后浏览器工作台初查（09-29） | 默认 Workbench、行业组件同步、导入草稿切换清理、原文对照与身份操作可用 | 真实页面发布新配置仍因未读取已有 active revision 而 CAS 冲突，已分配修复；UI 热更新期间不把中途重载算完整闭环通过 |
| 冻结后的配置/宿主/UI 独立复核（09-29） | 增强 HTTP 1 文件 / 4 项通过，28.92s；UI 5 文件 / 13 项通过，20.75s；18 文件对应 TypeScript/TSX ESLint 通过 | active GET、真实 CAS、metadata 即时更新、重启后同旧 run 的完整回答 JSON 与证据比较；两个行业同链。Web build 通过，缺失 ActiveProfileRecord type import 已补后独立复核 |
| 实际浏览器与 subprocess 历史读取（09-29） | 全程实际页面：原始 T-04 导入 → 原文对照 → pending/match → approve/publish → facts 查询 → published 正文“否” → 打开证据 | 工业同一个 1.0.1 配置由失败重试后成功 CAS（revision 1→2），刷新仍为新版本。进程 restart 后同 run 的 PublishedAnswer JSON 完全一致；同证据 verifiable/integrity=true，浏览器深链旧 run 仍显示原正文与引用。全部为合成资料、模型关闭 |
| 模型工厂和抽取预算独立检查（09-29） | 3 文件 / 20 项通过，3.94s；7 个 owner TypeScript 文件 ESLint 通过 | 受控 loopback HTTP、每 provider attempt 唯一计量、重试/未知用量/取消、原生输入和缺模型前置拒绝。默认宿主、planner/verifier 接线与外部模型质量未据此完成 |
| 已提交批次后的完整 unit/contracts/UI/architecture（09-29） | 127 文件 / 1,429 项全部通过，95.43s，exit 0 | 原有六个 UI 导入失败和支撑单元正例已恢复，新增配置、模型计量和来源检查纳入。本次不包含 PostgreSQL/integration/load/acceptance/browser projects，后续模型接线变更仍须复核 |
| 正式支撑 PostgreSQL/HTTP 与来源 UI 正例恢复（09-29） | 两 PG 文件 / 9 项通过，25.89s；reader/producer/UI/architecture 四文件 / 34 项通过，20.60s；9 个代码/测试文件 ESLint 通过 | 实际 PublishedSemanticSource、IncrementalMaterializer 写不可变切片再归档；多实体歧义/精确 payload 定位、撤回后旧序列支撑、OR、关系排除、分页和隔离全部保留。UTC 等价序列化不改写工件/hash；UI 支撑覆盖独立显示，归档可复核不再称原来源可重读 |
| Planner JEV 实际状态边界（09-29） | planner 与 question-rewriting 两文件 / 18 项通过，2.74s；三 owner TypeScript 文件 ESLint 通过 | 状态先归档/授权，不向官方 port 发送问题 hash；缺能力不调用 decision，取消/预算/归档 fatal 传播、可恢复失败显式标记。host/planner 正常模型执行仍另行验收 |
| 启动器模型角色独立隔离（09-29） | Node 6 项通过，syntax 与两 owner 文件 ESLint 通过 | Company-only/JEV-only、默认全关和 Vite 配置过滤；没有据此声称实际外网模型接通 |

上表是不同时间的聚焦检查点，存在覆盖重叠；不相加为一次全量通过数量。实际 prepare 检查只覆盖当时已有迁移至 `053`，不包含后来新增的 `054`/`055`/`056`。本次生成的临时 env、验证脚本、容器和卷已回收。已有 3000/5173/54329 环境未改动。

Dispatch 独立命令：`pnpm exec vitest run tests/unit/workflow-dispatch.spec.ts tests/integration/workflow-dispatch-postgres.spec.ts --maxWorkers=1`，2 文件 / 6 项、11.08s、exit 0。PG 集成通过真实 RunService 创建 run；受控 profile binder 与管理 SQL 故障注入只用于该存储模块测试，不充当最终产品 E2E。

## C2 独立 PostgreSQL 接线检查：初次失败已修复

命令：

```text
pnpm exec vitest run tests/integration/incremental-materialization-postgres.spec.ts tests/integration/materialization-worker-postgres.spec.ts tests/integration/publication-fence-postgres.spec.ts --maxWorkers=1
```

初次检查点结果：3 文件 / 4 项失败。前三项在物化器调用规则求值时没有传入已锁定 `definitionRef`；publication-fence 正例没有生成所要求的业务结论。失败清理还暴露测试未在 `finally` 关闭 composition pool 的问题。对应缺口已修复，保留业务正例而非把 true 期望改成 undefined。

之后独立复跑上述三文件和 `tests/integration/identity-decisions-postgres.spec.ts`：4 文件 / 14 项通过，48.07s、exit 0；没有原来的 unhandled connection errors。identity 测试同时验证 split fence 与 outbox/read head 原子提交及失败回滚。真实 PG 大 parent 的 1,001 辅助属性加主属性投影为 1,002 个 child facts；撤回一个 parent 后保留替代支撑，最后支撑撤回后 unknown。此检查仍是模块集成，部分物化夹具使用已发布行和受控 identity reader；最终正常 raw import/真实身份裁决/HTTP/UI 仍须另外验证。

规则条件满足与业务结论需要显式绑定。缺少审核后的结论绑定时只能产生适用性工件；条件不成立或例外成立不等于业务命题为 false。旧 scalar 物化用例还需增加真实属性子投影的支撑/撤回测试。

## 已确认、已分配的修复项

| 问题 | 处理方向 | owner |
| --- | --- | --- |
| 同一 VersionRef 不同对象引用误判为多 schema | 按 id/version/digest 完整键去重 | Core source |
| active 身份不匹配被丢弃却声明完整 | 明确 incomplete，禁止部分输入被当成当前完整结果 | Core source + materializer |
| 空/缺属性实体没有规则实例 | 独立保留实体/对象 subject，缺前提应为 unknown | Core source |
| 父 statement 事件不能命中属性 child | source parent、candidate、child logical ID 依赖别名 | rules/index/consumer |
| 身份 split 没接入物化事件 | 处理实际 split outbox，撤销旧身份支撑；旧 tombstone 不阻断修复后 scope | source + rules/consumer |
| logical ruleId 和 instance key 不同 | 按已发布逻辑规则/对象定位实体实例 | rules/index |
| latest heads 不能重建历史 asOf | 已持久 slice/原答案保留；缺历史快照明确不支持，不用当前头补历史 | source + materializer |
| 依赖索引及逐实体编译重复全扫描 | 预分组；单实体变化不扩展到无关实体 | rules/index/compiler |
| 多个有效时间边界之后没有开放 tail | 补半开有效区间末尾，验证不同时刻发布后的当前 slice | rules/materializer |
| 当前不完整或 fence 阻断已有历史 slice | 已存历史切片独立读取；当前查询仍保持完整性阻断 | rules/materializer |
| 实体实例的 qualified key 没有实体维度 | 实体限定的 proposition identity，保持物化/按需读取一致 | rules/evaluator/materializer |
| 任务丢失、旧 owner 或迟到结果写入 | 持久 dispatch、lease/attempt/revision fencing，并接到实际 host/publisher | dispatch + Core host |
| 语义核验 hash-only state 和多层计量 | 实际 state provider、独立持久 ref 登记、adapter 单 attempt 计量、visible not_run、fatal 传播 | Verifier 已独立单测；Core host/store 登记和实际运行仍待验证 |
| 可选 dispatch hook 下无条件 202 | 正常宿主强制执行能力；缺 hook 明确不可运行，兼容被动配置不能称正常执行 | Core API/host 待关闭 |
| 分页事实的 coverage 未进入归档 payload | 201 条事实、200 条一页时保留完整性与 continuation；阻止部分列表被无条件核验为完整答案 | Core tool contract/handler/draft 待修复 |
| 支撑来源查询仍沿用旧 scalar/global 链 | 核对实例/属性 child 到原 statement/evidence 的映射；修复真实正例，旧夹具按合法 scope 重建，不削弱来源断言 | Core provenance + 独立读审 |

本表表示问题与方案已确认，不表示最终代码或验收已通过。源/存储、物化 owner、调度 owner 分工明确；根代理负责独立复核和统一 Git 提交。

## 最终交付仍需执行

原始 JSON 到已发布属性事实回答、两个行业的 HTTP 链、浏览器配置生效和同历史回答重启读取已通过上述检查。剩余产品门槛包括普通资料的模型抽取、正常规则回答及其完整来源、真实宿主中的单次/小计划/有界 loop、取消/澄清、修改和撤回后的当前/历史规则行为。最后执行适用 lint/typecheck/contracts/boundaries、完整 Vitest、web build 和全部浏览器 E2E，并在实施 SPEC 填入实际证据与未验证项。

启动脚本的纯配置测试、真实 prepare、实际 subprocess launcher 与浏览器事实操作已有证据；`core-main.ts` 已调用真实 composition。规则回答和可安全恢复的运行阶段仍需验收。根代理已在先前冻结批次复核 platform/Web/acceptance TypeScript；后续模型宿主改动需在冻结后重新检查。真实外部模型质量、客户数据质量和真实设备均没有据此验收。
