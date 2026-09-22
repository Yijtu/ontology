import { ToolGatewayError } from './errors'

/**
 * Classified cancellation/timeout failure for the tool path (C4/C5, C6.2).
 *
 * A cancelled or timed-out read may already have reached the remote, so the platform
 * cannot assume the call was free: the error carries `remoteStateUnknown` and the
 * gateway settles the reservation as `usage_unknown` instead of releasing it. The
 * canonical code is `DEADLINE_EXCEEDED` (504), the catalogue entry whose behaviour
 * records an unknown remote state.
 */
export function cancellationError(message: string): ToolGatewayError {
  return new ToolGatewayError('HANDLER_FAILED', message, {
    platformCode: 'DEADLINE_EXCEEDED',
    remoteStateUnknown: true,
  })
}

/**
 * Reject a pending adapter call as soon as the propagated signal aborts.
 *
 * A backend that truly supports interruption should also abort its own work; this
 * helper guarantees the handler stops waiting and produces a classified failure even
 * when the backend can only be asked to cancel (best-effort notification, C5). The
 * original backend error still wins if it arrives first.
 */
export function raceWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError(message))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError(message))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
