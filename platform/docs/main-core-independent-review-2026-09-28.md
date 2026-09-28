# main Core 独立验证记录（进行中）

本轮基线：`main@51c8cb4`；实施分支：`feat/main-core-product-20260928`。本文件记录根代理的独立复核，不代替实施 SPEC 的最终验收矩阵。

截至本检查点，远端最新提交为 `2e7a044`，新增详细 README、行业原始资产与状态引用存储测试；上一实现批次 `5e6744d` 包括本体属性投影/物化、事实查询桥、实际语义核验状态、持久正文及工作台发布交互。C3 的默认宿主、完整恢复接线，C4 的两行业正常导入至问答与完整页面仍在实现。不得将下面的模块测试写成产品已交付。

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

本表表示问题与方案已确认，不表示最终代码或验收已通过。源/存储、物化 owner、调度 owner 分工明确；只有 Core 统一 Git 提交。

## 最终交付仍需执行

真实 HTTP/UI 从原始资料导入开始的完整链、两行业和异构 mapping、配置实际发布/生效、单次/小计划/有界 loop、取消/澄清/重启、正文与来源、修改/撤回后的当前与历史行为。最后执行适用 lint/typecheck/contracts/boundaries、完整 Vitest、web build 和全部浏览器 E2E，并在实施 SPEC 填入实际证据与未验证项。

启动脚本的纯配置测试和真实 prepare 已有证据；`core-main.ts` 已出现数据库 health 和行业 metadata 入口，但正式 run/worker 仍在接线，完整 API/Worker/Web readiness 尚未验证。旧完整 TypeScript 通过记录早于新 loader；loader owner 的全平台检查已通过，不能据此标整个新宿主与最终 Web/acceptance 组合已验收。真实外部模型质量、客户数据质量和真实设备均没有据此验收。
