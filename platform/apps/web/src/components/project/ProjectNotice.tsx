import { classifyPublicError } from '../../state/public-errors'
import { Button } from '../ui'

export function ProjectNotice({
  error,
  onRecover,
}: {
  readonly error: unknown
  readonly onRecover?: () => void
}) {
  const failure = classifyPublicError(error)
  return (
    <section className="project-notice" role="alert" data-family={failure.family}>
      <strong>{failure.title}</strong>
      <p>{failure.reason}</p>
      {failure.recovery === 'none' || onRecover === undefined ? null : (
        <Button onClick={onRecover}>{failure.recovery === 'refresh' ? '刷新后再确认' : '重试读取'}</Button>
      )}
      <details>
        <summary>技术详情</summary>
        <p>{failure.code}</p>
        {failure.traceId === undefined ? null : <p>追踪编号：{failure.traceId}</p>}
        {failure.reasons.map((reason, index) => (
          <p key={index}>{reason}</p>
        ))}
      </details>
    </section>
  )
}
