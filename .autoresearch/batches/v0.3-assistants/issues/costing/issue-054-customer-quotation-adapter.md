# V03-054：实现可替换报价端口与两种合成适配的契约套件

阶段 B · backend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #54，本批尚未开始实现。

## 目标与范围

- 注册CustomerQuotationPort与QuoteFunctionBinding，完成两种独立synthetic适配与同端口conformance；固定算法/adapter/input/output mapping版本，保留真实适配挂载位置。
- 归档原始request/response、price pins和invocation receipt，校验精度/Schema/明细/合组分摊；客户仅给总额时不得伪造逐行单价与费用。
- 共享deadline/signal/ledger、并发logical key与unknown恢复；无幂等/状态查询不得盲重调。至少两种adapter测试实现运行同一端口套件，真实未授权部分保持未就绪。
- 本卡交付内部机制不含真实客户adapter实现；真实协议/许可/权威价回执由V03-070完成，缺真实配置时正式任务保持未就绪。

## 依赖与进入条件

依赖：[V03-051](issue-051-accepted-main-sync.md)、[V03-049](issue-049-authority-discovery.md)、[V03-052](issue-052-industry-package.md)、[V03-053](issue-053-price-snapshots.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 注册CustomerQuotationPort与QuoteFunctionBinding，完成两种独立synthetic适配与同端口conformance；固定算法/adapter/input/output mapping版本，保留真实适配挂载位置。
- [ ] 归档原始request/response、price pins和invocation receipt，校验精度/Schema/明细/合组分摊；客户仅给总额时不得伪造逐行单价与费用。
- [ ] 共享deadline/signal/ledger、并发logical key与unknown恢复；无幂等/状态查询不得盲重调。至少两种adapter测试实现运行同一端口套件，真实未授权部分保持未就绪。
- [ ] 本卡交付内部机制不含真实客户adapter实现；真实协议/许可/权威价回执由V03-070完成，缺真实配置时正式任务保持未就绪。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口)

故事范围：P.US-007、P.US-017、P.US-023。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-007.AC-02 → P-T007-02：可绑定授权的已注册函数版本；未绑定或契约不兼容时显示“不可执行”及原因。
- P.US-017.AC-02 → P-T017-02：正常请求通过已注册报价动作执行，保存逐行结果、调用记录、失败和覆盖情况。
- P.US-017.AC-03 → P-T017-03：客户函数不可用或未获确认时不给正式报价；替身只能产出显式合成结果。
- P.US-017.AC-04 → P-T017-04：数量、金额和币种遵守明确精度及舍入契约；内部浮点函数的边界需对照确认。
- P.US-021.AC-02 → P-T021-02：执行中有阶段进度和取消入口；重试沿用同一逻辑动作标识，不能重复生成计价动作。
- P.US-023.AC-03 → P-T023-03：动作、数据后端与运行时由明确契约装配；不兼容组合拒绝并说明原因。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。
- P.FR-24 → P-F24：系统必须固定报价输入、价格、规则和函数的版本引用。
- P.FR-25 → P-F25：系统必须由确定性函数产出报价金额。
- P.FR-31 → P-F31：系统必须支持有界任务取消与幂等重试。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
