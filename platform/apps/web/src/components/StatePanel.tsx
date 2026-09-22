import type { ReactNode } from 'react'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'

const TITLES: Record<Exclude<WorkbenchPhase, 'ready'>, string> = {
  loading: '正在加载配置…',
  empty: '尚无已注册组件',
  not_configured: '配置未完成',
  failure: '操作失败',
  permission_denied: '权限不足',
}

export interface StatePanelProps {
  readonly phase: Exclude<WorkbenchPhase, 'ready'>
  readonly error?: WorkbenchError
  /** A surface-specific title; the default is the workbench wording. */
  readonly title?: string
  readonly children?: ReactNode
}

/**
 * One distinct, non-misleading panel per non-ready state. `loading` is announced as busy;
 * `permission_denied` never suggests a retry; `failure` carries the classified code and the
 * server trace id so the operator can quote it.
 */
export function StatePanel({ phase, error, title, children }: StatePanelProps) {
  return (
    <section className="state-panel" data-state={phase} role="status" aria-live="polite">
      <h2 className="state-panel__title">{title ?? TITLES[phase]}</h2>
      {error === undefined ? null : (
        <div className="state-panel__detail">
          <p data-testid="state-error-code">错误码：{error.code}</p>
          <p data-testid="state-error-message">{error.message}</p>
          {error.reasons !== undefined && error.reasons.length > 0 ? (
            <ul data-testid="state-error-reasons">
              {error.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {error.traceId === undefined ? null : (
            <p className="state-panel__trace">traceId：{error.traceId}</p>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
