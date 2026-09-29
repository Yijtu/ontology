import { Component } from 'react'
import type { ReactNode } from 'react'

export interface ScenarioErrorBoundaryProps {
  readonly children: ReactNode
  /** Changing this key retries the subtree, so a module can recover without a full reload. */
  readonly resetKey: string
  readonly renderFallback: (retry: () => void) => ReactNode
}

interface ScenarioErrorBoundaryState {
  readonly failed: boolean
}

/**
 * Containment for a registered scenario module. A broken professional renderer must not take
 * down the public shell; the shell shows a recovery panel and lets the operator retry the same
 * verified version instead of re-running the task (SPEC v0.3a §9.2, §10).
 */
export class ScenarioErrorBoundary extends Component<
  ScenarioErrorBoundaryProps,
  ScenarioErrorBoundaryState
> {
  override state: ScenarioErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ScenarioErrorBoundaryState {
    return { failed: true }
  }

  override componentDidUpdate(previous: ScenarioErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  private readonly retry = (): void => {
    this.setState({ failed: false })
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.renderFallback(this.retry)
    return this.props.children
  }
}
