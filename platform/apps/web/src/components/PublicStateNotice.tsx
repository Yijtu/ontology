import type { PublicFailure } from '../state/public-errors'
import { publicRecoveryLabel } from '../state/public-errors'

/**
 * The single public state notice (SPEC generic-assistants-core §5.3, asset-data-ui §9.2/§10).
 * Every public component renders a classified failure through this component so the same family
 * wording, capability gaps and recovery entry appear everywhere. A non-retryable failure shows no
 * retry button, and the class code plus trace id are kept separate from the Chinese reason so a
 * raw 500 body is never the visible message and the page/draft is never replaced by an error page.
 */
export interface PublicStateNoticeProps {
  readonly failure: PublicFailure
  /** Runs the family recovery: retry the stage, refresh the readback, or resume. */
  readonly onRecover?: () => void
  readonly recoverLabel?: string
  readonly testId?: string
  readonly className?: string
}

export function PublicStateNotice({ failure, onRecover, recoverLabel, testId, className }: PublicStateNoticeProps) {
  const label = recoverLabel ?? publicRecoveryLabel(failure.recovery)
  const canRecover = failure.recovery !== 'none' && onRecover !== undefined
  return (
    <section
      className={className === undefined ? 'public-state' : `public-state ${className}`}
      data-testid={testId ?? 'public-state'}
      data-family={failure.family}
      data-recovery={failure.recovery}
      data-retryable={failure.retryable}
      data-code={failure.code}
      role="alert"
      aria-live="polite"
    >
      <h4 className="public-state__title">{failure.title}</h4>
      <p className="public-state__reason" data-testid="public-state-reason">
        {failure.reason}
      </p>
      {failure.missingCapabilities.length === 0 ? null : (
        <ul className="public-state__capabilities" data-testid="public-state-capabilities">
          {failure.missingCapabilities.map((name) => (
            <li key={name} data-testid="public-state-capability" data-capability={name}>
              {name}
            </li>
          ))}
        </ul>
      )}
      {failure.reasons.length === 0 ? null : (
        <ul className="public-state__detail" data-testid="public-state-reasons">
          {failure.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="public-state__code" data-testid="public-state-code">
        错误码：{failure.code}
      </p>
      {failure.traceId === undefined ? null : (
        <p className="public-state__trace">traceId：{failure.traceId}</p>
      )}
      {canRecover ? (
        <button
          type="button"
          data-testid="public-state-recover"
          data-recovery={failure.recovery}
          onClick={onRecover}
        >
          {label}
        </button>
      ) : null}
    </section>
  )
}

/** The empty state writes what is required and the next step, mirroring the not-ready notice. */
export interface PublicEmptyStateProps {
  readonly title?: string
  readonly requirement: string
  readonly nextStep: string
  readonly testId?: string
}

export function PublicEmptyState({ title = '暂无数据', requirement, nextStep, testId }: PublicEmptyStateProps) {
  return (
    <section className="public-empty" data-testid={testId ?? 'public-empty'} data-state="empty" role="status">
      <h4 className="public-empty__title">{title}</h4>
      <p data-testid="public-empty-requirement">所需资料：{requirement}</p>
      <p data-testid="public-empty-next">下一步：{nextStep}</p>
    </section>
  )
}
