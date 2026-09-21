import type { BoundRunView } from '../api/client'
import type { WorkbenchError } from '../state/workbench'

export interface BoundRunPanelProps {
  readonly run?: BoundRunView
  readonly error?: WorkbenchError
  readonly loading: boolean
}

/**
 * A run that is already bound to a resolved manifest. The locked `resolvedProfileHash` is
 * shown so an operator can see that switching/activating a profile never moves a running
 * run onto the new version.
 */
export function BoundRunPanel({ run, error, loading }: BoundRunPanelProps) {
  return (
    <section className="bound-run" data-testid="bound-run" data-state={loading ? 'loading' : error !== undefined ? 'failure' : 'ready'}>
      <h3>已锁定运行版本</h3>
      {loading ? <p>正在读取运行记录…</p> : null}
      {error === undefined ? null : (
        <p data-testid="bound-run-error">
          读取失败：{error.code} — {error.message}
        </p>
      )}
      {run === undefined ? null : (
        <dl>
          <dt>runId</dt>
          <dd data-testid="bound-run-id">{run.runId}</dd>
          <dt>状态</dt>
          <dd>{run.state}</dd>
          <dt>锁定清单哈希</dt>
          <dd data-testid="bound-run-hash">{run.resolvedProfileHash}</dd>
        </dl>
      )}
    </section>
  )
}
