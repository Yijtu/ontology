# v0.3 A 能力补齐与前端升级

用户已确认 23 节点、并行 3；每波全部交付后再推进下一波。独立批次，不执行旧队列或 B 造价任务。

基线：43525be；原始 review 来自 2026-10-08 的本机资料（不复制原文/个人记忆）。

- [Manifest](manifest.json)
- [Frontend design](frontend-design.md)
- [Interactive direction](frontend-design.html)

最终节点在全部前置能力进入 main 后，以真实 Core 重写简洁生动的根 README。

Wave 0: GAP-001, GAP-002, GAP-017

Wave 1: GAP-003, GAP-004, GAP-005

Wave 2: GAP-006, GAP-009, GAP-010

Wave 3: GAP-007, GAP-011, GAP-012

Wave 4: GAP-008, GAP-013, GAP-014

Wave 5: GAP-015, GAP-016, GAP-018

Wave 6: GAP-019, GAP-020, GAP-021

Wave 7: GAP-022

Wave 8: GAP-023


## GitHub mapping

| Local ID | Issue | Dependencies |
|---|---|---|
| [GAP-001](issues/gap-001-source-grounding.md) | [#251](https://github.com/Yijtu/ontology/issues/251) | None |
| [GAP-002](issues/gap-002-publication-gate.md) | [#252](https://github.com/Yijtu/ontology/issues/252) | None |
| [GAP-003](issues/gap-003-relation-premises.md) | [#253](https://github.com/Yijtu/ontology/issues/253) | None |
| [GAP-004](issues/gap-004-compute-digest.md) | [#254](https://github.com/Yijtu/ontology/issues/254) | None |
| [GAP-005](issues/gap-005-identity-recall.md) | [#255](https://github.com/Yijtu/ontology/issues/255) | None |
| [GAP-006](issues/gap-006-competency-fixtures.md) | [#256](https://github.com/Yijtu/ontology/issues/256) | None |
| [GAP-007](issues/gap-007-grounded-tbox.md) | [#257](https://github.com/Yijtu/ontology/issues/257) | #251, #252, #256 |
| [GAP-008](issues/gap-008-rule-action-generation.md) | [#258](https://github.com/Yijtu/ontology/issues/258) | #251, #252, #257 |
| [GAP-009](issues/gap-009-dynamic-terminology.md) | [#259](https://github.com/Yijtu/ontology/issues/259) | #252 |
| [GAP-010](issues/gap-010-structured-facts.md) | [#260](https://github.com/Yijtu/ontology/issues/260) | #252, #255 |
| [GAP-011](issues/gap-011-project-query.md) | [#261](https://github.com/Yijtu/ontology/issues/261) | #260 |
| [GAP-012](issues/gap-012-published-rule-chain.md) | [#262](https://github.com/Yijtu/ontology/issues/262) | #253 |
| [GAP-013](issues/gap-013-ontology-evolution.md) | [#263](https://github.com/Yijtu/ontology/issues/263) | #252, #260, #261 |
| [GAP-014](issues/gap-014-premise-verification.md) | [#264](https://github.com/Yijtu/ontology/issues/264) | #251, #253, #260, #262 |
| [GAP-015](issues/gap-015-semantic-task-routing.md) | [#265](https://github.com/Yijtu/ontology/issues/265) | #261, #262, #264 |
| [GAP-016](issues/gap-016-competency-release-gate.md) | [#266](https://github.com/Yijtu/ontology/issues/266) | #254, #256, #258, #261, #262, #264 |
| [GAP-017](issues/gap-017-frontend-foundation.md) | [#267](https://github.com/Yijtu/ontology/issues/267) | None |
| [GAP-018](issues/gap-018-structured-document-index.md) | [#268](https://github.com/Yijtu/ontology/issues/268) | #251, #260 |
| [GAP-019](issues/gap-019-production-wiring.md) | [#269](https://github.com/Yijtu/ontology/issues/269) | #254, #259, #263, #265, #266, #268 |
| [GAP-020](issues/gap-020-ontology-workbench.md) | [#270](https://github.com/Yijtu/ontology/issues/270) | #257, #258, #259, #266, #267 |
| [GAP-021](issues/gap-021-project-business-workbench.md) | [#271](https://github.com/Yijtu/ontology/issues/271) | #255, #261, #263, #264, #265, #267, #268 |
| [GAP-022](issues/gap-022-frontend-acceptance.md) | [#272](https://github.com/Yijtu/ontology/issues/272) | #267, #269, #270, #271 |
| [GAP-023](issues/gap-023-main-acceptance.md) | [#273](https://github.com/Yijtu/ontology/issues/273) | #269, #272 |
