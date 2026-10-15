# GAP-004 · 让 compute 版本锁绑定真实处理器产物

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: infra

## Scope

- `platform/packages/tool-services/src/compute/`
- `platform/packages/contracts/src/compute.ts（仅确需字段时）`
- `platform/tests/unit/compute-execution.spec.ts`
- `platform/tests/integration/compute-execution-postgres.spec.ts`

## Acceptance

- [ ] handlerDigest 来自确定性构建产物及其被调用的受控领域代码依赖，禁止对固定标签字符串或仅函数 toString 求摘要。
- [ ] 改处理器或领域依赖而不改版本字符串时摘要变化；相同内容可重现。登记、任务 binding、执行工件和回读核验绑定同一真实摘要。
- [ ] 旧任务锁定旧摘要时不得执行新处理器；新注册版本才能采用新摘要，缺失产物/摘要不一致显式拒绝。
- [ ] 保留注册式 compute 与有限参数契约，覆盖依赖变更、旧 binding、跨作用域及取消；提供接客户函数所需的工厂，不调用客户报价服务。

## Dependencies

None

## Scope boundary



## Evidence at 43525be

- `packages/tool-services/src/compute/example-operation.ts:80`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #254

Dependencies: None
