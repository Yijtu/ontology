import type {
  ToolContext,
  Uuid,
  WorkflowDispatchFence,
  WorkflowDispatchLease,
  WorkflowDispatchPort,
} from '@ontology/contracts'
import type { WorkflowController, WorkflowView } from '@ontology/application'

export interface WorkflowDispatchWorkerOptions {
  readonly dispatch: WorkflowDispatchPort
  readonly controller: WorkflowController
  /** Trusted tenant/space context used only for the dispatch table. */
  readonly dispatchContext: ToolContext
  /** Creates a fresh trusted, canonical run context after the row has been claimed. */
  readonly contextForRun: (runId: Uuid) => Promise<ToolContext>
  readonly ownerId?: Uuid
  readonly leaseDurationMs?: number
  readonly idlePollMs?: number
  readonly onFenceChange?: (runId: Uuid, fence: WorkflowDispatchFence | undefined) => void
  readonly onError?: (error: unknown) => void
}

type DriveResult =
  | { readonly kind: 'success'; readonly view: WorkflowView }
  | { readonly kind: 'failure'; readonly error: unknown }

/**
 * A single-owner polling worker for the durable controller queue. It renews the lease while
 * the controller is active, aborts runtime work on lease loss, and only completes/fails with
 * the latest CAS fence. An expired worker can never publish because its latest fence is also
 * attached to the controller's publication grant and checked in the answer-store transaction.
 */
export class WorkflowDispatchWorker {
  readonly #options: WorkflowDispatchWorkerOptions
  readonly #ownerId: Uuid
  readonly #leaseDurationMs: number
  readonly #idlePollMs: number

  constructor(options: WorkflowDispatchWorkerOptions) {
    this.#options = options
    this.#ownerId = options.ownerId ?? globalThis.crypto.randomUUID()
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000
    this.#idlePollMs = options.idlePollMs ?? 250
    if (this.#leaseDurationMs < 1_000 || this.#leaseDurationMs > 300_000) {
      throw new RangeError('workflow dispatch lease duration must be between 1000 and 300000 ms')
    }
    if (this.#idlePollMs < 10 || this.#idlePollMs > 30_000) {
      throw new RangeError('workflow dispatch poll interval must be between 10 and 30000 ms')
    }
  }

  async tick(): Promise<boolean> {
    await this.#options.dispatch.reconcileOpenRuns(this.#options.dispatchContext)
    const lease = await this.#options.dispatch.claimNext(
      { ownerId: this.#ownerId, leaseDurationMs: this.#leaseDurationMs },
      this.#options.dispatchContext,
    )
    if (lease === undefined) return false
    await this.#driveLease(lease)
    return true
  }

  /** RunApi hook after RunService has authorized and persisted cancellation. */
  async cancelRun(runId: Uuid, ctx: ToolContext): Promise<void> {
    await this.#options.dispatch.cancelRun(runId, ctx)
    this.#options.controller.abortActiveWork(runId, 'run cancelled by user')
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const claimed = await this.tick()
        if (!claimed) await delay(this.#idlePollMs, signal)
      } catch (error) {
        this.#options.onError?.(error)
        await delay(this.#idlePollMs, signal)
      }
    }
  }

  async #driveLease(initial: WorkflowDispatchLease): Promise<void> {
    const { dispatch, controller, dispatchContext } = this.#options
    const runId = initial.payload.runId
    let lease = initial
    let leaseLost = false
    const publishFence = (): WorkflowDispatchFence => ({
      dispatchId: lease.dispatchId,
      ownerId: lease.leaseOwnerId,
      attempt: lease.attempt,
      expectedRevision: lease.revision,
    })
    this.#options.onFenceChange?.(runId, publishFence())

    let runContext: ToolContext
    try {
      runContext = await this.#options.contextForRun(runId)
    } catch (error) {
      await this.#fail(lease, error)
      this.#options.onFenceChange?.(runId, undefined)
      return
    }

    let outcome: DriveResult | undefined
    const recoveredAttempt = BigInt(initial.attempt) > 1n || initial.logicalActionId.startsWith('recovery:')
    const settled = controller.drivePersistedRun(
      runId,
      runContext,
      recoveredAttempt,
      initial.logicalActionId,
    ).then(
      (view): DriveResult => ({ kind: 'success', view }),
      (error: unknown): DriveResult => ({ kind: 'failure', error }),
    )
    const renewalInterval = Math.max(500, Math.floor(this.#leaseDurationMs / 3))
    try {
      while (outcome === undefined) {
        outcome = await Promise.race([settled, delay(renewalInterval).then(() => undefined)])
        if (outcome !== undefined) break
        try {
          lease = await dispatch.renew(
            {
              dispatchId: lease.dispatchId,
              ownerId: lease.leaseOwnerId,
              attempt: lease.attempt,
              expectedRevision: lease.revision,
              leaseDurationMs: this.#leaseDurationMs,
            },
            dispatchContext,
          )
          this.#options.onFenceChange?.(runId, publishFence())
        } catch (error) {
          leaseLost = true
          this.#options.onFenceChange?.(runId, undefined)
          controller.abortActiveWork(runId, 'durable workflow lease was lost')
          this.#options.onError?.(error)
          outcome = await settled
        }
      }

      if (leaseLost) return
      if (outcome.kind === 'success') {
        await dispatch.complete(publishFence(), dispatchContext)
      } else {
        try {
          await controller.failPersistedRun(runId, errorCode(outcome.error), runContext)
        } catch (stateFailure) {
          this.#options.onError?.(stateFailure)
        }
        await this.#fail(lease, outcome.error)
      }
    } finally {
      this.#options.onFenceChange?.(runId, undefined)
    }
  }

  async #fail(lease: WorkflowDispatchLease, error: unknown): Promise<void> {
    const code = errorCode(error)
    try {
      await this.#options.dispatch.fail(
        {
          dispatchId: lease.dispatchId,
          ownerId: lease.leaseOwnerId,
          attempt: lease.attempt,
          expectedRevision: lease.revision,
          failureCode: code,
        },
        this.#options.dispatchContext,
      )
    } catch (failure) {
      this.#options.onError?.(failure)
    }
    this.#options.onError?.(error)
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code)) return code
  }
  return 'workflow_failed'
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds)
    const abort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
