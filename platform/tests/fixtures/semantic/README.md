# 语义回归夹具（LOCAL-048）

本目录提供规格驱动的语义回归输入与金标，供规则求值、物化投影、溯源历史与端到端验收复用。夹具是声明式 JSON，金标由当前 SPEC/PRD 独立推导并人工复核，**不是**任何实现的运行输出。

- 夹具：`*.fixture.json`
- 夹具信封 Schema：`semantic-fixture.schema.json`（对公共契约成员用 `$ref` 指向 `@ontology/contracts` 的 canonical schema）
- 加载/校验：`loader.ts`
- 契约测试：`platform/tests/contracts/semantic-fixtures/semantic-fixtures.spec.ts`

## 定位与边界

- **只交付测试输入和金标**。本卡完成不代表算法、物化或业务验收已经通过；通过夹具不等于通过验收。
- 金标来自规格：每个夹具的 `provenance.specRefs` 指向当前仓库 SPEC/PRD 文件与章节，`provenance.derivation` 写明推导依据。禁止用被测实现或历史原型程序生成期望值。
- 公共形状复用 canonical schema：`ScopeRef`、`ValidityInterval`、`SourceRef`、`VersionRef`、`SemanticFilter`、`ControlReadProjectionRequest`、`DomainResultStatus`、`EvidenceEnvelope`、`SourceSnapshot`。夹具信封只定义夹具元数据。
- 确定性：夹具为静态 JSON，`loader.ts` 不读网络、不取时钟、不用随机、不读本目录以外文件、不 import 历史程序。`loadFixtures()` 可重复运行且顺序稳定。
- 不绑定实现：夹具不声明 proof 数量、字段布局或测试数量；`expected.views[].conclusions[].satisfiedBy` 只描述该场景下金标支撑，不是实现必须产出的证明条数。

## 场景覆盖

`scenarioKind` 取值与对应规格：

| scenarioKind | 规格依据 | 覆盖点 |
|---|---|---|
| `and_prerequisites` | D5 | AND 前提：所有 premise group 都需有效支撑 |
| `or_alternative_support` | D5, US-017.A1 | OR 替代支撑：撤回其一仍保留结论 |
| `last_support_retraction` | D5, US-017.A1 | 最后支撑撤回：无有效支撑则结论撤出，标 unknown |
| `unknown_conflict` | D5, SPEC §2.1 | 未知不默认 false；单值冲突 |
| `numeric_boundary` | D5, E4, D3 | 闭/开区间边界、精确负数、半开有效区间 |
| `partial_validity_correction` | D3.1, US-017.A2 | 部分区间更正不抹掉其他区间 |
| `history_view` | D3.1, US-017.A2 | asOfRecordedSeq + validAt 双时态视图、tombstone |

## 夹具结构

```text
{
  fixtureId, scenarioKind, title,
  provenance: { specRefs[], functionalRequirements[], userStories[], acceptanceRefs[]?, derivation },
  notes?,                        // 可选：审阅澄清（例如故意未发布的 assertion）
  scopeRef,                       // canonical ScopeRef
  assertions: [ { assertionId, logicalAssertionId, recordedSeq, op, subject, predicate,
                  value?, validity, sourceRef, evidenceId? } ],
  rules: [ { ruleRef, ruleId, premiseGroups: [ { groupId, filter: SemanticFilter,
             alternatives: [ { alternativeId, assertionId } ] } ], conclusion } ],
  evidence: [ EvidenceEnvelope ],  // canonical
  operations: [ { stepId, kind, assertionId?, ruleId?, asOfRecordedSeq?, validAt? } ],
  expected: {
    views: [ { viewId, description, request: ControlReadProjectionRequest,
               isCurrent, conclusions[], gaps[], conflicts[] } ],
    evidenceConditions: [ { evidenceId, condition, required } ]
  }
}
```

- `premiseGroups` 是“AND of ORs”：不同 group 全部必需，同 group 内 alternatives 等价。
- 每个夹具恰好一个 `isCurrent: true` 视图，表示“最新 recorded 版本”的当前视图；其余视图是历史/双时态切片。
- `op=retract` 是 tombstone，`op=correct` 只作用于显式 `validity` 区间；历史 payload 不被覆盖。

## 加载与断言

```ts
import {
  loadFixtures,
  fixturesOfKind,
  createFixtureValidator,
  fixtureSetDigest,
  semanticFixtureDir,
} from '<repo>/platform/tests/fixtures/semantic/loader'

const fixtures = loadFixtures()               // 已校验，按 fixtureId 排序
const andFixture = fixturesOfKind(fixtures, 'and_prerequisites')[0]
```

- `loadFixtures()`：读取目录内全部 `*.fixture.json`，对信封 schema（内部 `$ref` canonical schema）校验后返回类型化数组；重复调用结果与 `fixtureSetDigest()` 一致。
- `createFixtureValidator()`：单独取信封校验器。
- `canonicalValidator(ref)` / `schemaRef(file, def)`：取任意 canonical `$defs` 校验器，例如 `schemaRef('evidence.schema.json','EvidenceEnvelope')`。
- `canonicalJson(value)` / `fixtureSetDigest(fixtures)`：稳定序列化与集合摘要。

断言建议：先跑 `loadFixtures()` 与 `createFixtureValidator()` 证明输入合规，再对被测实现断言 `expected.views` 与 `expected.evidenceConditions`。不要断言夹具文件数或某实现内部证明条数。

## 各消费方的约定

### LOCAL-032（规则求值与紧凑支撑 DAG）

- 输入：`assertions`、`rules`（`premiseGroups` + `SemanticFilter`）、对应 `evidence`。
- 断言：对每个 `expected.views[].request`（`asOfRecordedSeq`/`validAt`）求值，比较 `conclusions[].domainStatus`、`value`、`satisfiedBy`；核对 `gaps`/`conflicts`。
- 重点：`and_prerequisites` 的 AND、`or_alternative_support` 的组内多源、`unknown_conflict` 的 unknown/conflict 不得被压成 false、`numeric_boundary` 的闭/开边界与精确小数。
- 不要求：与夹具无关的 proof 数量或记录结构。

### LOCAL-033（增量物化 / 双时态投影 / 失效围栏）

- 输入：`assertions`（含 `op`、`recordedSeq`、`validity`）、`operations`（事件顺序）、`expected.views`（双时态金标）。
- 断言：按 `operations` 顺序发布事件后，对每个 view 的 `ControlReadProjectionRequest` 投影，比较 `conclusions`/`gaps`/`conflicts`；`partial_validity_correction` 与 `history_view` 覆盖部分区间更正、tombstone 与旧 recorded 版本不可见后续事实。
- 重点：撤回一前提不误删仍有替代支撑的结论；所有支撑消失才撤出；处理中 fence 与 dirty 状态不得把旧派生当当前（本卡只给输入与金标，围栏行为由 LOCAL-033 自证）。

### LOCAL-034（溯源 / 历史 API）

- 输入：`evidence`（canonical `EvidenceEnvelope` + `dependencies` 的 `derives_from`/`corrects`/`retracts`/`contradicts`）、`expected.views`、`evidenceConditions`。
- 断言：给定 view 的 `asOfRecordedSeq`/`validAt`，可展开到 `evidenceConditions` 指定的证据；被撤回/更正的证据作为历史仍可查，且不随当前投影更新被抹除。
- 重点：`history_view` 中旧 recorded 版本读不到后来才获知的别名/更正。

### LOCAL-054（端到端验收）

- 输入：整套夹具（`loadFixtures()`）。
- 断言：以夹具为固定输入走完整链路（导入→抽取→发布→求值→物化→回答→溯源），复用 LOCAL-032/033/034 的断言口径；`fixtureSetDigest()` 可写入验收报告以固定输入版本。
- 重点：本卡只提供输入与金标，E2E 通过与否由 LOCAL-054 结合真实链路判定；CI 不读取历史演示库或旧 ID。

## 验证命令

```text
pnpm install
pnpm run verify            # lint + typecheck + test
pnpm vitest run tests/contracts/semantic-fixtures
```
