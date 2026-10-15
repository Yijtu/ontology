import { useEffect, useId, useRef } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
}) {
  return <button type="button" {...props} className={`ui-button ui-button--${variant} ${className}`} />
}

export function Panel({ title, description, actions, children, className = '' }: {
  readonly title: string; readonly description?: string; readonly actions?: ReactNode
  readonly children: ReactNode; readonly className?: string
}) {
  return <section className={`ui-panel ${className}`}>
    <header className="ui-panel__head"><div><h2>{title}</h2>{description === undefined ? null : <p>{description}</p>}</div>{actions}</header>
    <div className="ui-panel__body">{children}</div>
  </section>
}

/** Wrap a labelled control with its help text; the render callback owns the actual input type. */
export function Field({ label, hint, error, children }: {
  readonly label: string; readonly hint?: string; readonly error?: string
  readonly children: (attributes: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode
}) {
  const id = useId()
  const description = error ?? hint
  return <div className="ui-field"><label htmlFor={id}>{label}</label>
    {children({ id, ...(description === undefined ? {} : { 'aria-describedby': `${id}-help` }), ...(error === undefined ? {} : { 'aria-invalid': true }) })}
    {description === undefined ? null : <p id={`${id}-help`} className={error === undefined ? 'ui-field__hint' : 'ui-field__error'}>{description}</p>}
  </div>
}

export function StatusBadge({ tone = 'neutral', children }: {
  readonly tone?: 'neutral' | 'success' | 'warning' | 'danger'; readonly children: ReactNode
}) {
  return <span className={`ui-status ui-status--${tone}`}><span aria-hidden="true">{tone === 'success' ? '✓' : tone === 'warning' || tone === 'danger' ? '!' : '·'}</span>{children}</span>
}

export function StateFeedback({ title, description, tone = 'empty', action, children }: {
  readonly title: string; readonly description: string; readonly tone?: 'empty' | 'loading' | 'error'
  readonly action?: ReactNode; readonly children?: ReactNode
}) {
  return <section className={`ui-feedback ui-feedback--${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-busy={tone === 'loading'}>
    <span className="ui-feedback__symbol" aria-hidden="true">{tone === 'loading' ? '…' : tone === 'error' ? '!' : '◇'}</span>
    <div><h2>{title}</h2><p>{description}</p>{children}{action}</div>
  </section>
}

export function DataTable({ caption, children, ...props }: HTMLAttributes<HTMLTableElement> & { readonly caption: string }) {
  return <div className="ui-table-scroll" tabIndex={0} role="region" aria-label={caption}><table {...props}><caption>{caption}</caption>{children}</table></div>
}

/** Native modal semantics make the background inert; the fallback supports component tests. */
export function Drawer({ open, title, children, onClose, placement = 'side' }: {
  readonly open: boolean; readonly title: string; readonly children: ReactNode
  readonly onClose: () => void; readonly placement?: 'side' | 'center'
}) {
  const id = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const dialog = ref.current
    if (dialog === null) return undefined
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    const first = dialog.querySelector<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex="0"]')
    first?.focus({ preventScroll: true })
    return () => {
      if (typeof dialog.close === 'function') dialog.close()
      if (trigger?.isConnected === true) trigger.focus({ preventScroll: true })
    }
  }, [open])
  if (!open) return null
  return <dialog ref={ref} className={`ui-drawer ui-drawer--${placement}`} aria-labelledby={id} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); closeRef.current() }}
    onClick={(event) => { if (event.target === event.currentTarget) closeRef.current() }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      const focusable = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')
      const first = focusable?.[0]
      const last = focusable?.[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }) }
    }}>
    <div className="ui-drawer__surface"><header className="ui-drawer__head"><h2 id={id}>{title}</h2><Button variant="quiet" onClick={onClose} aria-label={`关闭${title}`}>关闭 ×</Button></header>
      <div className="ui-drawer__body">{children}</div>
    </div>
  </dialog>
}
