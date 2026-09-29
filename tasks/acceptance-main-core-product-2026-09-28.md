# main POC Core 独立业务验收金标

日期：2026-09-28。配合 [实施 SPEC](spec-main-core-product-2026-09-28.md)。本文件由根代理根据业务条件编写，不读取实现结果生成期望。用于避免同一段代码既生成结果又生成金标。以下数据和规则全部是合成验证样例，不是行业标准、真实法规或客户承诺。

字段 ID/对象 ID 可以由实施者映射为实际行业声明，但业务含义、缺失状态、身份、单位和来源不可改变。样例数据必须经正常来源接入、parser/抽取、身份裁决、审核/发布进入系统；不得直接插入候选、已发布事实、派生结论或答案来通过最终 E2E。

## 1. 场景 T：交通设施巡检

行业定义含 Facility、District、located_in 关系；设施属性包括稳定设施编号、地区、inspection_due（boolean）、inspection_exempt（可缺失 boolean）。规则 R-T：对于同一设施，inspection_due 为 true，且明确没有 inspection_exempt 时，当前规则要求巡检。已声明 exception 为 inspection_exempt=true；没有观测到 exemption 不能视为 false。

| 设施 | 地区 | inspection_due | inspection_exempt | R-T 期望 |
| --- | --- | --- | --- | --- |
| T-01 | north | true | false | 成立；需要巡检 |
| T-02 | north | true | true | 因例外而不成立；不能声称规则要求巡检 |
| T-03 | north | true | 缺失 | unknown；说明豁免依据缺失 |
| T-04 | south | false | false | 主条件不成立 |
| T-05 | north | true | 缺失 | unknown |
| T-06 | north | 缺失 | false | unknown；不得用 T-06 的 false 支撑 T-05 |

R-T 的结果只描述这条已发布规则。没有完整业务规则范围时，“R-T 不成立”不能扩写成“该设施在任何情况下都不用巡检”。

必须有两个独立来源为 T-01 的 inspection_due=true 提供支撑：例如登记来源 A 和现场复核来源 B，来源 ID/文件内容/采集记录不同；不是复制同一份文档冒充独立证据。operator 显式确认二者属于同一实体，而不是名称相似自动合并。

示例业务问题：

1. north 区有哪些设施？——返回查询授权范围内 T-01/T-02/T-03/T-05/T-06，实体 ID、地区和各自数据依据可查。
2. 按 R-T，north 区哪些设施确定需要巡检？——确定结果只有 T-01；T-03/T-05/T-06 的缺口不能隐去或改 false。
3. T-02 为什么没有被这条规则要求巡检？——引用其 exemption=true、R-T 例外条件、来源与版本；不能只说“系统已优化”。
4. 文档里关于豁免的原句是什么？——精确 quote 与 locator/digest；不能让模型改写原文后仍标原句。

## 2. 场景 I：工业资产维护

定义含 Asset、Workshop 及安装/所属关系；资产属性为稳定资产编号、operating_hours（精确数量，单位 h）、maintenance_exempt（boolean，允许缺失）。

规则 R-I：同一资产 operating_hours >= 100 h 且 maintenance_exempt 明确为 false 时，此规则要求维护；exception 为 maintenance_exempt=true。

| 资产 | operating_hours | maintenance_exempt | R-I 期望 |
| --- | --- | --- | --- |
| I-01 | 120 h | false | 成立 |
| I-02 | 120 h | true | 例外成立，规则不成立 |
| I-03 | 90 h | false | 阈值未满足 |
| I-04 | 100 h | false | 边界成立 |
| I-05 | 缺失 | false | unknown，不填 0 |
| I-06 | 120 h | 缺失 | unknown，不默认没有豁免 |

第二物理布局可以使用 accumulated_minutes、asset_key、workshop_code、waiver_flag=0/1；通过明确 mapping 转成 canonical hours 和 boolean。6000 min = 100 h，5999 min < 100 h。两种布局对相同业务实体/问题应输出相同语义值和判定，来源指向各自真实物理对象，不能把源值 6000 标 h。

不允许交通字段、资产字段或规则阈值写入通用 Controller/数据查询 handler。二场景挂载只换声明、mapping、任务/策略及必要适配器。

## 3. 变化与历史

固定一个可追溯的初始发布版本 V1 和业务时间/记录视图，先取得查询与规则答案。

1. 撤回 T-01 来源 A 的 due=true 支撑。来源 B 仍有效：R-T 当前结论仍成立，来源图应不再把 A 当当前有效支撑。
2. 再撤回 B。当前 due 缺有效依据：T-01 当前结果 unknown/失效；不得继续以旧 true 发布普通当前结论。
3. 读取 V1/as-of 的历史事实/旧答案：原支撑、正文、时间和“历史结果”标注仍可读，不能改写为当时不存在。
4. 修改一个实体条件，不影响另一实体。更换 schema/mapping 新版本影响新运行；旧 run 使用原锁定版本。
5. 投影 fence/dirty 期间，不能用旧缓存伪装当前完整已知。分页期间并发发布或撤回，结果必须来自固定 snapshot，或明确重试/不完整。

来源修订与撤回需正常 API 及权限。不能直接 UPDATE 测试数据库来替代以上完整产品验收；故障注入型集成测试另行标注。

## 4. 查询/结果/权限反例

- 用户询问一个未注册且无可用路由的问题：clarification/unsupported/limited，不回预设设施列表或 SOC。
- 概念或物理表不在 mapping/白名单：拒绝，不让模型补写裸 SQL。
- 数值一致而单位不同、不同 subject、来源时点晚于 declared asOf：硬核验失败。
- 枚举或 boolean claim 与真实结果不符：阻断。
- quote 字符、字节范围或 digest 不匹配：不能标精确引用已核验。
- 模型故意给出 wrong R-T/R-I verdict，即使 JEV 返回高概率：确定性规则核验阻断。
- source/schema/身份 revision 变化：不能静默把旧 evidence 当当前。
- 业务用户尝试审批/发布/撤回：拒绝；另一个 tenant/space 的 ID 即使已知也不能读取。

## 5. 生命周期与恢复

只从正常 HTTP/UI 提交，不手动 Controller.startRun：

- 同逻辑请求相同 idempotency key、不同客户端临时 runId：得到原 canonical runId，同一 ledger，不多调用模型/工具。
- 在 collecting/drafting 期间取消：真实 signal 传至 runtime/模型/工具；迟到结果不能发表正文。
- 澄清后继续：same run/budget，保留已固定来源版本并重验权限。
- 应用 restart：已发布正文/hash/evidence 不变；支持的检查点按相同版本恢复，不支持时明确错误。
- 第一次执行/发布响应丢失：相同逻辑键能读回持久结果；客户端不通过换键制造新逻辑动作。
- 两个进程/并发操作争用：按受支持的 host 并发策略租约/CAS，一次有效发布/写入，不把无CAS upsert当作多进程保证。

## 6. 分页与规模边界

至少构造 1001 条实际发布属性/statement，并让必要的有效 OR 支撑和一个规则版本位于后页。要求结论与完整输入金标一致。第 1000 条不意味着全体完整。

总量达到配置 cap 时，一条额外记录能区分“恰好完整”和“截断”。重复/倒退游标、跨页 revision 变化或无法取得完整时明确 INCOMPLETE；不以缺失事实推导 false。

这些检查验证实现边界，不宣称任意容量或 QPS。不得借全球清理 Docker 卷腾空间；测试只清自己创建的容器和命名卷。

## 7. 最终演示与证据

演示顺序：选配置→导入文档/记录→看真实 job→确认身份与审核→发布→普通提问→展示正文/typed事实或规则→展开来源→撤回支撑再提问→读取旧答案→挂载第二场景。

记录：

- run/job/publication/schema/mapping/规则/投影版本；
- 正文及已核验 draft/content hash；
- 关键工具 calls、bounded budget 和 no-progress 停止；
- 具体 source/object/parse/span 或 query result pointer；
- 当前与历史视图区别；
- Generation/JEV 为受控HTTP还是实际外部服务；
- 每个已通过/未通过/未验证门槛及限制。

只替换模型响应仍能验证真实业务链。只有“页面有结果”“模块测试绿”“证据数量为2”不足以通过本轮核心产品验收。


## 8. 独立方案审查补充（实施约束）

以下细化实施 SPEC 的 A05/A06/A08/A10—A14；遇到文字不明确处，以这些更精确的语义和验收为准。

### 8.1 规则适用性与业务命题分开

规则是“满足条件则提供一条结论支撑”。condition=false 或 exception=true 只说明该规则不提供正向支撑，**不能由此推导业务结论为 false**。

可以发布明确的规则适用性判定“R-T 对 T-02 不适用”，并引用例外证据；对“这设施是否需要巡检”的业务命题，若没有其他有效正向支撑且没有明确否定事实，状态是 unknown/没有有效推导。不能将“不适用”写成“不需要”。

四态组合至少验证：

- condition=true / exception=false：该规则提供正向支撑。
- condition=true / exception=true：移除该规则正向支撑；其他规则/来源仍可能支持业务命题。
- condition=true / exception=unknown：unknown，不能把缺失例外当 false。
- condition=true / exception=conflict：conflict/不能提供已知正向支撑，保留冲突依据。
- condition=unknown / exception=false：unknown。
- condition=conflict / exception=false：conflict。
- condition=false 或 exception=true 的情况不得制造业务命题的否定事实；即使另一条件未知，不能产生正向支撑，来源冲突仍需展示。

追加 exception 从 false→缺失→true 的修订序列：旧 true 的支撑要正确退出当前投影，历史保持；若另有合法 OR 支撑，命题继续成立。

### 8.2 属性和时态投影隔离

投影键至少绑定 tenant/space、canonical entity、definition/attribute version、有效时段、来源及记录版本。不同客户同 nativeId、同名实体、不同对象同 attributeId、不同时间事实均不得混用。

相同实体同一有效时间中的冲突值不能因“OR 替代支撑”选任意一个。规则的所有前提必须在同一请求 validAt/asOf 可见；不能拿过去温度和未来豁免拼出结论。

### 8.3 持久调度和竞争

HTTP 已接受的运行必须有持久 dispatch 记录，进程退出不能把它永久丢在 created。需要明确运行 owner/lease/attempt 或等价 CAS 策略。

崩溃点包括：run 已创建但未执行；工具尚未返回；已核验未发布。重启后沿原 run 和原 budget 恢复/明确受控终态；过期 lease、旧 attempt 和取消后的迟到结果不能发布、重开 ledger 或重发副作用。

### 8.4 模型 state 与用量归属

actual state 必须来自本次 run 固定版本的获授权内容，并带字节/记录上限与完整性；不能解引用任意客户端 id。

规划、改写、抽取、草稿、JEV 与各自重试有唯一 reserve/settle owner。每个实际尝试记一次用量，所属 run/job ledger 不重置。受控 HTTP 校验发送内容、总 usage、取消和 usage_unknown；外层 Controller 与 adapter 不能重复收费。

### 8.5 主 E2E 可播种的唯一范围

只允许预置原始业务表/文件、行业声明、映射、模型受控响应及本地授权配置。

不得直接向 candidates、identity assertions、published statements、属性投影、派生事实、verifications 或答案表插入金标结果。这些产物必须经正常 API/Worker/审核/发布/Controller 产生。模块级故障注入测试可以单独操作持久层，但不能冒称主产品验收。
