# main Core 独立验证记录（进行中）

本轮基线：`main@51c8cb4`；实施分支：`feat/main-core-product-20260928`。本文件记录根代理的独立复核，不代替实施 SPEC 的最终验收矩阵。

截至本检查点，最新已提交实现为 `5145a56`。C2 的源读取、依赖索引和物化接线，C3 的持久调度及宿主，C4 的完整页面和第二行业演示仍在实现。不得将下面的模块测试写成产品已交付。

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

上表是不同时间的聚焦检查点，存在覆盖重叠；不相加为一次全量通过数量。实际 prepare 检查只覆盖当时已有迁移至 `053`，不包含后来新增的 `054`/`055`。本次生成的临时 env、验证脚本、容器和卷已回收。已有 3000/5173/54329 环境未改动。

Dispatch 独立命令：`pnpm exec vitest run tests/unit/workflow-dispatch.spec.ts tests/integration/workflow-dispatch-postgres.spec.ts --maxWorkers=1`，2 文件 / 6 项、11.08s、exit 0。PG 集成通过真实 RunService 创建 run；受控 profile binder 与管理 SQL 故障注入只用于该存储模块测试，不充当最终产品 E2E。

## C2 独立 PostgreSQL 接线检查：失败待修复

命令：

```text
pnpm exec vitest run tests/integration/incremental-materialization-postgres.spec.ts tests/integration/materialization-worker-postgres.spec.ts tests/integration/publication-fence-postgres.spec.ts --maxWorkers=1
```

检查点结果：3 文件 / 4 项失败。前三项在物化器调用规则求值时没有传入已锁定 `definitionRef`；publication-fence 正例没有生成所要求的业务结论。失败清理还暴露测试未在 `finally` 关闭 composition pool 的问题。实施者正在修复，不能删除正例或把 true 期望改成 undefined。

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
| 任务丢失、旧 owner 或迟到结果写入 | 持久 dispatch、lease/attempt/revision fencing，并接到实际 host/publisher | dispatch + Core host |

本表表示问题与方案已确认，不表示最终代码或验收已通过。源/存储、物化 owner、调度 owner 分工明确；只有 Core 统一 Git 提交。

## 最终交付仍需执行

真实 HTTP/UI 从原始资料导入开始的完整链、两行业和异构 mapping、配置实际发布/生效、单次/小计划/有界 loop、取消/澄清/重启、正文与来源、修改/撤回后的当前与历史行为。最后执行适用 lint/typecheck/contracts/boundaries、完整 Vitest、web build 和全部浏览器 E2E，并在实施 SPEC 填入实际证据与未验证项。

启动脚本的纯配置测试和真实 prepare 已有证据；`core-main.ts` 与 API/Worker/Web readiness 尚未验证。真实外部模型质量、客户数据质量和真实设备均没有据此验收。
