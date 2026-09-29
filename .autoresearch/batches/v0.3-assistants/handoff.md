# v0.3 实施交接

本次只完成技术规格和本地任务创建。没有启动实现、服务、模型或客户报价调用，没有合并、提交、push。

## 基线与入口

文档工作区 D:/work/ontology-core-main，实际分支 feat/electrical-costing-poc@b339b8f6a1167218becdd7b33d144c02660f43ce。main 快照 19c411e8db444e289e8c3ec0395ae909f2534601；通用研发 feat/core-planning-provenance@d17c7b520298703feb65f86761f34f1557927aca 有 WIP。开工重新核对并保留原任务修改。

依赖、优先级和就绪以 [manifest.json](manifest.json) 为准。PRD/四份 SPEC 摘要校验失败说明规格漂移，先更新任务，不按旧内容盲执行。V03-001 是唯一初始可核对的通用代码批次入口；V03-048～050 只做外部范围、函数和样本核对。

## A 的退出与 B 的进入

- A 的源码存在/WIP集成/受控演示都不等于完成。正常入口、独立两行业/两mapping/两runtime/两业务SQL后端/真实MCP、全表核验及浏览器负例通过；公共前端、使用说明、迁移与限制完整。
- V03-047 保存独立审查及 main release record：main SHA、能力/Schema/运行支持版本、迁移配置、验证证据、真实模型未验证限制。只有该能力已合入 main 才满足进入条件。
- V03-051 同步该主线并保存祖先关系/场景兼容回归。后续 B 代码节点均依赖此卡；公共能力增量继续 main-first。
- B 的清单/价格/费用/税费/舍入/权威函数/图纸覆盖按 discovery 签核。未确认的正式业务路径保持未就绪；synthetic流程只能证明机制。
- V03-069 是内部合成整栈验证，V03-070 是真实客户适配，V03-071 是真实模型/函数/配对gold与业务签核。V03-072 的正式MVP退出不能用内部演示代替真实条件。

## loop-it 衔接

当前 loop-it 技能读取 GitHub open Issues，本批是独立本地卡，并非该技能可以直接消费的远程队列。后续进入已授权实施时，先按阶段发布实际 ready 卡，记录真实 GitHub 编号/URL；保留现有 .loop-state.json，不创建另一份冲突执行记录。

指定 loop 的批次/Issue allowlist 和 completed 判定，勿扫描旧队列后把能源卡或未满足条件的造价卡一起执行。Issue 前置依赖须完成且验证有效，外部缺资源保持 discovery，不把人工签核任务交给模型伪完成。

## 验证与状态

- 工程命令以 platform/package.json 为准：verify、boundaries、test:acceptance；浏览器先 build:web 再 test:e2e（Vitest配置内真实Playwright chromium）。
- 每卡记录实际测试命令/结果与提交，只有满足验收才完成；coverage 中的测试是计划，不是通过证据。
- 密钥、客户原始资料、代码及真实价格留在授权环境。本批只存机制、合成/获准脱敏fixture和资料引用。
- 本地 V03 编号不等于 GitHub #编号。现有旧 LOCAL 卡和执行记录独立保留，V03-001 去重核对后再实现。
