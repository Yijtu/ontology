# Durable workflow dispatch

Migration `054_workflow_dispatch.sql` and `WorkflowDispatchPort` provide the durable queue
primitive for Core's run driver. This port is adapter infrastructure; HTTP acceptance,
controller restoration, and result publication remain responsibilities of the Core host.

## Logical action and payload

The idempotency key is `(tenantId, spaceId, runId, actionKind, logicalActionId)`. The
current action kind is `drive_run`; `logicalActionId` is stable for one logical drive. A
retried enqueue with the same key returns its existing dispatch row. A later clarification
or resume of that run needs a different action id. The dispatch stores `{ runId }` as JSON
and a canonical UTF-8 SHA-256 digest; it does not copy questions, answers, evidence, or
budget state. Enqueue rejects a run not visible in the trusted scope and a composite foreign
key ties every dispatch to its actual persisted run.

Example, after the Core host has created the run through `RunService`:

```ts
const dispatch = await dispatches.enqueue(
  { runId, logicalActionId: 'initial-drive' },
  trustedContext,
)
```

The store has no budget dependency and cannot create another run ledger. The host must keep
run creation and enqueue recovery coherent: a process can still exit between those separate
calls unless the host joins them transactionally or enumerates accepted runs missing a
dispatch on startup.

## Lease and cancellation rules

`claimNext` claims one due pending row or one expired lease inside the tenant/space carried
by a host-minted context. PostgreSQL uses `FOR UPDATE SKIP LOCKED`; each claim increments
both `attempt` and `revision`. Lease duration is bounded to 1–300 seconds and expiry is
computed from the database clock.

Each worker mutation echoes `dispatchId`, `ownerId`, `attempt`, and `expectedRevision` from
the latest lease. Renew, complete, and fail also require an unexpired lease; they all advance
the monotonic revision. An expired lease may be claimed by another owner as a new attempt,
which fences the old worker. Failure stores a bounded machine-readable code only; it never
stores provider messages or customer payloads.

The trusted host cancels with the dispatch's current revision. Cancellation may revoke a
pending row or a leased row, clears its lease, advances the revision, and makes the row
terminal. The old worker then cannot renew or complete that dispatch. The controller must
also verify the RunService state and the current dispatch fence immediately before publishing;
this store does not combine run cancellation, dispatch cancellation, or answer publication
into one transaction.

All reads and mutations require a branded `ToolContext`. The PostgreSQL adapter takes tenant
and space only from that context, applies explicit scope predicates, and relies on the table's
RLS policy as a second layer. Background claiming is a host capability and must not be
exposed to an ordinary run caller.

## Verification

`tests/unit/workflow-dispatch.spec.ts` checks bounded lease and identifier validation before
database access. `tests/integration/workflow-dispatch-postgres.spec.ts` runs migration 054
against a throwaway PostgreSQL container with a labelled named volume and uses the
non-owner `ontology_app` role for store calls. It creates each raw run through `RunService`;
it does not insert candidates, facts, verifications, answers, or publication results.

The focused checks run on 2026-09-28:

```powershell
pnpm exec eslint packages/contracts/src/workflow-dispatch.ts packages/adapters/control-postgres/src/workflow-dispatch-store.ts tests/unit/workflow-dispatch.spec.ts tests/integration/workflow-dispatch-postgres.spec.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vitest run tests/unit/workflow-dispatch.spec.ts
pnpm exec vitest run tests/integration/workflow-dispatch-postgres.spec.ts --maxWorkers=1
pnpm --filter @ontology/contracts run check:contracts
```

Results: focused ESLint and platform typecheck passed; the unit file passed 2/2; the
throwaway PostgreSQL integration file passed 4/4; generated contract output matched the
canonical schema. The integration cases cover repeated enqueue and distinct resume actions,
payload digest verification, unchanged budget-ledger rows, tenant RLS, two competing
claimers, renew/complete fencing, expired lease reclaim, stale attempt rejection, leased and
pending cancellation, terminal failure, invalid failure-row rejection by PostgreSQL, and
missing-run rejection. The expiry test moves only its own dispatch's lease into the past as
module-level fault injection.

These checks validate the port and its persistence boundary. They do not validate normal
HTTP enqueue, host startup recovery, crash-gap recovery, independent API/worker restart, or
browser behavior; they do not establish C3 or A13 product acceptance.
