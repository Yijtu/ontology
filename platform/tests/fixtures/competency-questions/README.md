# 独立能力问题金标

这里是两个合成行业的 **21 个声明和独立预期**，不是执行报告，也不是行业标准。预期按资料与公开规则人工可核对地推导，直接写入 JSON；没有调用查询、规则、物化、模型或旧程序来生成答案。

- 交通设施：单项长度、精确合计、巡检前提、例外、缺观察、冲突、一跳边与目标条件、跨项目拒绝、错维度拒绝，以及明确观察形成的 false。
- 工业维护：时长与合计、三层规则、缺观察、OR 支撑撤回、历史记录点、定义 v1/v2 和闭区间阈值。
- 每题有独立 `derivation`。例如 `12.5+5.0=17.5 m`、`120+30=150 h`；例外阻断不代表业务命题为假；撤回一条 OR 支撑不抹掉另一条。

`*.cq.json` 是 canonical Schema 校验后的版本信封；`ref.digest` 只哈希 body，不哈希自身。`*.assets.json` 是实际定义草稿和有限规则声明，均有真实内容摘要。`assets.ts` 仅提供类型化声明和确定性哈希，不是解释器。声明草稿没有发布事件或执行回执。

`*.source.txt` 是可回读的合成资料。局部 `.gitattributes` 固定 LF；摘要取原始文件 bytes，定位单位固定 `utf8_byte`，范围是 `[startOffset,endOffset)`，quote 摘要也取这个原始 byte 切片。不得换成 UTF-16 下标、自动换行归一化或另外一份文本去补出匹配摘要。

`loader.ts` 检查 schema、body 摘要、定义/规则 inventory、磁盘资产与原始来源 bytes/locator。它不运行答案算法。规则上游引用是声明依赖，三层和撤回场景必须由后续真实 runner 完成；不能把预期直接当运行结果或预插入由规则推导的字段。

真实人工报价有独立资源接口，但本夹具的三个资源仍缺失：授权报价输入、人工金标和客户 compute binding。`externalGold.acceptance` 始终是 `unverified`；合成样例不补这个验收位。

```text
pnpm exec vitest run tests/contracts/competency-questions.spec.ts tests/contracts/schema-type-consistency.spec.ts
```

这条检查证明声明与来源完整性，不证明 GAP-016 runner 或真实客户质量通过。
