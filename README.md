# ontology

行业语义与业务 Agent 平台。当前包含需求、技术规格、任务卡，以及 TypeScript 工作区和依赖边界检查；具体实施进度见任务清单与验证记录。

- [PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md)
- [SPEC v0.2](tasks/spec-industry-semantic-agent-v0.2.md)
- [家庭充电储能场景](tasks/scenario-home-energy-hackathon.md)
- [54 张本地 Issue](.autoresearch/issues/INDEX.md)
- [需求覆盖](.autoresearch/issues/coverage.md)
- [执行交接](.autoresearch/issues/handoff.md)
- [模型开发与代码审查约定](AGENTS.md)

TypeScript 工作区位于 `platform/`。本项目按当前 PRD/SPEC 独立建设；不要求兼容或迁移历史演示原型的代码、接口、数据库、测试或页面。开发、测试与验收仅依赖当前仓库及其明确声明的资源。LOCAL 与 GitHub Issue 的映射以 [manifest](.autoresearch/issues/manifest.json) 为准，不能按编号直接推断。
