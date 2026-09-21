# PRD / SPEC → 本地 Issue 覆盖

来源为 PRD v0.2、SPEC 主文及四分册。A1/A2… 是对应用户故事内验收清单的顺序。此表仅证明任务已承接，不表示功能或测试已完成。LOCAL-048 只准备依据当前规格独立构造的夹具；真正的行为验收由相关实现卡和 E2E 完成，不依赖历史原型。

## 用户故事验收覆盖

| 验收项 | 承接 Issue |
|---|---|
| US-001.A1 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-006](issue-006-component-registry.md) |
| US-001.A2 | [LOCAL-006](issue-006-component-registry.md)、[LOCAL-011](issue-011-tool-gateway-local.md) |
| US-002.A1 | [LOCAL-007](issue-007-profile-composition.md) |
| US-002.A2 | [LOCAL-037](issue-037-ui-profiles-sources.md) |
| US-003.A1 | [LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| US-003.A2 | [LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-041](issue-041-package-export-upgrade.md) |
| US-004.A1 | [LOCAL-018](issue-018-pi-runtime.md) |
| US-004.A2 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-036](issue-036-answer-publication-gate.md) |
| US-005.A1 | [LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| US-005.A2 | [LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| US-006.A1 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-011](issue-011-tool-gateway-local.md) |
| US-006.A2 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-036](issue-036-answer-publication-gate.md) |
| US-007.A1 | [LOCAL-014](issue-014-mcp-transport.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| US-007.A2 | [LOCAL-014](issue-014-mcp-transport.md) |
| US-008.A1 | [LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md) |
| US-008.A2 | [LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-037](issue-037-ui-profiles-sources.md) |
| US-009.A1 | [LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-026](issue-026-semantic-mapping-query.md) |
| US-009.A2 | [LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-026](issue-026-semantic-mapping-query.md) |
| US-010.A1 | [LOCAL-023](issue-023-document-parser-spans.md)、[LOCAL-024](issue-024-bm25-document-search.md) |
| US-010.A2 | [LOCAL-024](issue-024-bm25-document-search.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| US-011.A1 | [LOCAL-022](issue-022-durable-jobs-outbox.md) |
| US-011.A2 | [LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| US-012.A1 | [LOCAL-027](issue-027-entity-relation-extraction.md) |
| US-012.A2 | [LOCAL-027](issue-027-entity-relation-extraction.md)、[LOCAL-031](issue-031-semantic-publication.md) |
| US-013.A1 | [LOCAL-028](issue-028-rule-candidate-extraction.md) |
| US-013.A2 | [LOCAL-028](issue-028-rule-candidate-extraction.md) |
| US-014.A1 | [LOCAL-029](issue-029-identity-candidate-retrieval.md)、[LOCAL-030](issue-030-identity-decisions.md) |
| US-014.A2 | [LOCAL-030](issue-030-identity-decisions.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| US-015.A1 | [LOCAL-031](issue-031-semantic-publication.md) |
| US-015.A2 | [LOCAL-031](issue-031-semantic-publication.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| US-016.A1 | [LOCAL-032](issue-032-rule-evaluator-supports.md) |
| US-016.A2 | [LOCAL-033](issue-033-incremental-materialization.md) |
| US-017.A1 | [LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md) |
| US-017.A2 | [LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-040](issue-040-ui-provenance-history.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md) |
| US-018.A1 | [LOCAL-020](issue-020-route-plan-loop.md) |
| US-018.A2 | [LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-020](issue-020-route-plan-loop.md) |
| US-019.A1 | [LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-020](issue-020-route-plan-loop.md) |
| US-019.A2 | [LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-039](issue-039-ui-query-workflow.md) |
| US-020.A1 | [LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-024](issue-024-bm25-document-search.md)、[LOCAL-026](issue-026-semantic-mapping-query.md) |
| US-020.A2 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-021](issue-021-web-search-adapter.md) |
| US-021.A1 | [LOCAL-035](issue-035-draft-verification.md) |
| US-021.A2 | [LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-047](issue-047-ui-home-energy.md) |
| US-022.A1 | [LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-040](issue-040-ui-provenance-history.md) |
| US-022.A2 | [LOCAL-040](issue-040-ui-provenance-history.md) |
| US-023.A1 | [LOCAL-007](issue-007-profile-composition.md)、[LOCAL-041](issue-041-package-export-upgrade.md) |
| US-023.A2 | [LOCAL-041](issue-041-package-export-upgrade.md) |
| US-024.A1 | [LOCAL-049](issue-049-composition-conformance.md) |
| US-024.A2 | [LOCAL-050](issue-050-evaluation-load-harness.md)、[LOCAL-051](issue-051-live-model-validation.md) |
| US-025.A1 | [LOCAL-054](issue-054-end-to-end-acceptance.md) |
| US-025.A2 | [LOCAL-054](issue-054-end-to-end-acceptance.md) |
| US-025.A3 | [LOCAL-054](issue-054-end-to-end-acceptance.md) |
| US-025.A4 | [LOCAL-054](issue-054-end-to-end-acceptance.md) |

## 功能要求覆盖

| FR | 承接 Issue |
|---|---|
| FR-1 | [LOCAL-001](issue-001-typescript-workspace.md)、[LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-006](issue-006-component-registry.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| FR-2 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-007](issue-007-profile-composition.md)、[LOCAL-037](issue-037-ui-profiles-sources.md) |
| FR-3 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-006](issue-006-component-registry.md)、[LOCAL-007](issue-007-profile-composition.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| FR-4 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| FR-5 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| FR-6 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-014](issue-014-mcp-transport.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| FR-7 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-046](issue-046-energy-compute-simulation.md) |
| FR-8 | [LOCAL-014](issue-014-mcp-transport.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| FR-9 | [LOCAL-014](issue-014-mcp-transport.md)、[LOCAL-049](issue-049-composition-conformance.md) |
| FR-10 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-043](issue-043-energy-input-normalization.md)、[LOCAL-052](issue-052-ha-read-integration.md) |
| FR-11 | [LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-043](issue-043-energy-input-normalization.md)、[LOCAL-052](issue-052-ha-read-integration.md) |
| FR-12 | [LOCAL-005](issue-005-immutable-artifacts.md)、[LOCAL-023](issue-023-document-parser-spans.md)、[LOCAL-024](issue-024-bm25-document-search.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| FR-13 | [LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-031](issue-031-semantic-publication.md)、[LOCAL-038](issue-038-ui-jobs-review.md)、[LOCAL-050](issue-050-evaluation-load-harness.md) |
| FR-14 | [LOCAL-005](issue-005-immutable-artifacts.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-023](issue-023-document-parser-spans.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-027](issue-027-entity-relation-extraction.md)、[LOCAL-028](issue-028-rule-candidate-extraction.md)、[LOCAL-030](issue-030-identity-decisions.md)、[LOCAL-031](issue-031-semantic-publication.md)、[LOCAL-038](issue-038-ui-jobs-review.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| FR-15 | [LOCAL-023](issue-023-document-parser-spans.md)、[LOCAL-028](issue-028-rule-candidate-extraction.md) |
| FR-16 | [LOCAL-029](issue-029-identity-candidate-retrieval.md)、[LOCAL-030](issue-030-identity-decisions.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| FR-17 | [LOCAL-029](issue-029-identity-candidate-retrieval.md)、[LOCAL-030](issue-030-identity-decisions.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| FR-18 | [LOCAL-032](issue-032-rule-evaluator-supports.md)、[LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-043](issue-043-energy-input-normalization.md)、[LOCAL-044](issue-044-energy-simulator.md)、[LOCAL-045](issue-045-energy-planner.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md) |
| FR-19 | [LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-040](issue-040-ui-provenance-history.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md)、[LOCAL-050](issue-050-evaluation-load-harness.md) |
| FR-20 | [LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-040](issue-040-ui-provenance-history.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md)、[LOCAL-050](issue-050-evaluation-load-harness.md) |
| FR-21 | [LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-045](issue-045-energy-planner.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-051](issue-051-live-model-validation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-22 | [LOCAL-009](issue-009-run-events-api.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-23 | [LOCAL-009](issue-009-run-events-api.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-24 | [LOCAL-009](issue-009-run-events-api.md)、[LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-25 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-024](issue-024-bm25-document-search.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-046](issue-046-energy-compute-simulation.md) |
| FR-26 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-020](issue-020-route-plan-loop.md)、[LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-024](issue-024-bm25-document-search.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-046](issue-046-energy-compute-simulation.md) |
| FR-27 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-035](issue-035-draft-verification.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-047](issue-047-ui-home-energy.md)、[LOCAL-051](issue-051-live-model-validation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-28 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-035](issue-035-draft-verification.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-047](issue-047-ui-home-energy.md)、[LOCAL-051](issue-051-live-model-validation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-29 | [LOCAL-011](issue-011-tool-gateway-local.md)、[LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-035](issue-035-draft-verification.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-047](issue-047-ui-home-energy.md)、[LOCAL-051](issue-051-live-model-validation.md)、[LOCAL-053](issue-053-live-device-actions.md) |
| FR-30 | [LOCAL-005](issue-005-immutable-artifacts.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-040](issue-040-ui-provenance-history.md)、[LOCAL-047](issue-047-ui-home-energy.md) |
| FR-31 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-006](issue-006-component-registry.md)、[LOCAL-007](issue-007-profile-composition.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| FR-32 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-006](issue-006-component-registry.md)、[LOCAL-007](issue-007-profile-composition.md)、[LOCAL-009](issue-009-run-events-api.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-042](issue-042-home-energy-package.md) |
| FR-33 | [LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-014](issue-014-mcp-transport.md)、[LOCAL-016](issue-016-jev-decision-adapter.md)、[LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-043](issue-043-energy-input-normalization.md)、[LOCAL-044](issue-044-energy-simulator.md)、[LOCAL-045](issue-045-energy-planner.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md)、[LOCAL-049](issue-049-composition-conformance.md)、[LOCAL-050](issue-050-evaluation-load-harness.md)、[LOCAL-051](issue-051-live-model-validation.md)、[LOCAL-052](issue-052-ha-read-integration.md) |
| FR-34 | [LOCAL-054](issue-054-end-to-end-acceptance.md) |

## SPEC 设计任务映射

| 设计任务 | 本地 Issue |
|---|---|
| S01 | [LOCAL-001](issue-001-typescript-workspace.md)、[LOCAL-002](issue-002-canonical-contracts.md)、[LOCAL-003](issue-003-package-profile-manifests.md) |
| S02 | [LOCAL-004](issue-004-control-postgres-foundation.md)、[LOCAL-005](issue-005-immutable-artifacts.md)、[LOCAL-022](issue-022-durable-jobs-outbox.md) |
| S03 | [LOCAL-003](issue-003-package-profile-manifests.md)、[LOCAL-006](issue-006-component-registry.md)、[LOCAL-007](issue-007-profile-composition.md)、[LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-041](issue-041-package-export-upgrade.md) |
| S04 | [LOCAL-010](issue-010-budget-ledger.md)、[LOCAL-011](issue-011-tool-gateway-local.md) |
| S05 | [LOCAL-008](issue-008-source-bindings-probe.md)、[LOCAL-012](issue-012-postgres-query-adapter.md)、[LOCAL-013](issue-013-duckdb-query-adapter.md)、[LOCAL-026](issue-026-semantic-mapping-query.md) |
| S06 | [LOCAL-005](issue-005-immutable-artifacts.md)、[LOCAL-023](issue-023-document-parser-spans.md)、[LOCAL-024](issue-024-bm25-document-search.md) |
| S07 | [LOCAL-014](issue-014-mcp-transport.md) |
| S08 | [LOCAL-015](issue-015-generation-model-adapter.md)、[LOCAL-016](issue-016-jev-decision-adapter.md) |
| S09 | [LOCAL-009](issue-009-run-events-api.md)、[LOCAL-017](issue-017-template-runtime.md)、[LOCAL-018](issue-018-pi-runtime.md)、[LOCAL-019](issue-019-workflow-controller.md)、[LOCAL-020](issue-020-route-plan-loop.md) |
| S10 | [LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-035](issue-035-draft-verification.md)、[LOCAL-036](issue-036-answer-publication-gate.md)、[LOCAL-037](issue-037-ui-profiles-sources.md)、[LOCAL-039](issue-039-ui-query-workflow.md)、[LOCAL-040](issue-040-ui-provenance-history.md) |
| S11 | [LOCAL-022](issue-022-durable-jobs-outbox.md)、[LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-027](issue-027-entity-relation-extraction.md)、[LOCAL-028](issue-028-rule-candidate-extraction.md)、[LOCAL-029](issue-029-identity-candidate-retrieval.md)、[LOCAL-030](issue-030-identity-decisions.md)、[LOCAL-031](issue-031-semantic-publication.md)、[LOCAL-038](issue-038-ui-jobs-review.md) |
| S12 | [LOCAL-032](issue-032-rule-evaluator-supports.md)、[LOCAL-033](issue-033-incremental-materialization.md)、[LOCAL-034](issue-034-provenance-history-api.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md) |
| S13 | [LOCAL-025](issue-025-semantic-model-versions.md)、[LOCAL-026](issue-026-semantic-mapping-query.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-042](issue-042-home-energy-package.md)、[LOCAL-043](issue-043-energy-input-normalization.md) |
| S14 | [LOCAL-043](issue-043-energy-input-normalization.md)、[LOCAL-044](issue-044-energy-simulator.md)、[LOCAL-045](issue-045-energy-planner.md)、[LOCAL-046](issue-046-energy-compute-simulation.md) |
| S15 | [LOCAL-040](issue-040-ui-provenance-history.md)、[LOCAL-046](issue-046-energy-compute-simulation.md)、[LOCAL-047](issue-047-ui-home-energy.md) |
| S16 | [LOCAL-021](issue-021-web-search-adapter.md)、[LOCAL-041](issue-041-package-export-upgrade.md)、[LOCAL-048](issue-048-semantic-regression-fixtures.md)、[LOCAL-049](issue-049-composition-conformance.md)、[LOCAL-050](issue-050-evaluation-load-harness.md)、[LOCAL-054](issue-054-end-to-end-acceptance.md) |
| S17 | [LOCAL-051](issue-051-live-model-validation.md) |
| S18 | [LOCAL-052](issue-052-ha-read-integration.md)、[LOCAL-053](issue-053-live-device-actions.md) |

## 能源与替换验证

- E-01—03/E-09：LOCAL-042、043；E-04—06/E-08：LOCAL-044；E-06—08：LOCAL-045；E-10—12：LOCAL-046、047、054。
- X-01—08：LOCAL-049 为统一验收，相关真实实现分布在 LOCAL-012—018、026、041、046。
- 最终 E2E 为 LOCAL-054，依赖链覆盖 LOCAL-001—050。LOCAL-051—053 为外部条件验证，不以假响应替代。
