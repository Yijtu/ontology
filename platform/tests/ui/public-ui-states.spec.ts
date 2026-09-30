// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ApiError,
  PublicEmptyState,
  PublicStateNotice,
  classifyPublicError,
} from '@ontology/app-web'

/**
 * The shared public state contract (V03-042 / #216, SPEC generic-assistants-core §5.3,
 * asset-data-ui §10). Every public component renders its failures through this classifier and
 * notice, so the family wording, capability gaps and recovery entry stay consistent: a raw 500
 * never becomes the visible message, a Chinese reason is always present, and a non-retryable
 * family never offers a retry button.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

function apiError(status: number, code: string, extra: Partial<{ message: string; retryable: boolean; reasons: string[]; missingCapabilities: unknown[] }> = {}): ApiError {
  return new ApiError(status, {
    code,
    message: extra.message ?? `${code} detail`,
    retryable: extra.retryable ?? false,
    reasons: extra.reasons ?? [],
    missingCapabilities: extra.missingCapabilities ?? [],
  })
}

function render(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root.render(element)
  })
  mounted.push({ root, container })
  return container
}

describe('classifyPublicError maps the §5.3 / §10 error families to a Chinese reason and recovery', () => {
  it('turns a raw 500 into a retryable server family without exposing the body', () => {
    const failure = classifyPublicError(apiError(500, 'INTERNAL_ERROR', { message: 'stacktrace SECRET_DB_DSN', retryable: true }))
    expect(failure.family).toBe('server')
    expect(failure.recovery).toBe('retry')
    expect(failure.retryable).toBe(true)
    expect(failure.reason).toContain('服务端')
    expect(failure.reason).not.toContain('SECRET_DB_DSN')
  })

  it('separates permission from failure and never suggests a retry', () => {
    const failure = classifyPublicError(apiError(403, 'FORBIDDEN'))
    expect(failure.family).toBe('permission')
    expect(failure.recovery).toBe('none')
    expect(failure.retryable).toBe(false)
  })

  it('classifies a not-ready projection with its kind and a retry entry', () => {
    const failure = classifyPublicError({
      status: 409,
      code: 'DATASET_NOT_READY',
      message: 'dataset job running',
      retryable: true,
      reasons: ['materialization job 42 is building'],
      missingCapabilities: [],
    })
    expect(failure.family).toBe('not_ready')
    expect(failure.recovery).toBe('retry')
    expect(failure.reason).toContain('查询数据')
  })

  it('turns a stale revision into a refresh-readback recovery', () => {
    const failure = classifyPublicError(apiError(409, 'VERSION_CONFLICT'))
    expect(failure.family).toBe('conflict')
    expect(failure.recovery).toBe('refresh')
    expect(failure.reason).toContain('刷新回读')
  })

  it('names the missing capabilities in Chinese without exposing tool JSON', () => {
    const failure = classifyPublicError(
      apiError(409, 'CAPABILITY_NOT_CONFIGURED', { missingCapabilities: [{ name: 'pricing.compute' }, 'data.readonly'] }),
    )
    expect(failure.family).toBe('capability')
    expect(failure.recovery).toBe('none')
    expect(failure.missingCapabilities).toEqual(['pricing.compute', 'data.readonly'])
    expect(failure.reason).toContain('pricing.compute')
  })

  it('keeps invalid input non-retryable and budget exhaustion terminal', () => {
    expect(classifyPublicError(apiError(400, 'INVALID_ARGUMENT')).recovery).toBe('none')
    expect(classifyPublicError(apiError(422, 'SCHEMA_MISMATCH')).family).toBe('invalid')
    expect(classifyPublicError(apiError(422, 'BUDGET_EXHAUSTED')).family).toBe('budget')
    expect(classifyPublicError(apiError(422, 'BUDGET_EXHAUSTED')).recovery).toBe('none')
  })

  it('retries a transient model outage but not an unconfigured model', () => {
    expect(classifyPublicError(apiError(503, 'MODEL_UNAVAILABLE', { retryable: true })).recovery).toBe('retry')
    expect(classifyPublicError(apiError(409, 'MODEL_NOT_CONFIGURED')).recovery).toBe('none')
  })
})

describe('PublicStateNotice renders the reason, gaps and recovery consistently', () => {
  it('shows the Chinese reason, code and a retry entry that invokes the recovery', () => {
    let recovered = 0
    const container = render(
      createElement(PublicStateNotice, {
        failure: classifyPublicError(apiError(503, 'SOURCE_UNAVAILABLE', { retryable: true })),
        onRecover: () => {
          recovered += 1
        },
      }),
    )
    const notice = container.querySelector('[data-testid="public-state"]')
    expect(notice).not.toBeNull()
    expect(notice?.getAttribute('data-family')).toBe('source')
    expect(notice?.getAttribute('data-recovery')).toBe('retry')
    expect(container.querySelector('[data-testid="public-state-reason"]')?.textContent).toContain('来源')
    expect(container.querySelector('[data-testid="public-state-code"]')?.textContent).toContain('SOURCE_UNAVAILABLE')
    const recover = container.querySelector<HTMLButtonElement>('[data-testid="public-state-recover"]')
    expect(recover).not.toBeNull()
    act(() => {
      recover?.click()
    })
    expect(recovered).toBe(1)
  })

  it('omits the retry entry for a permission failure but keeps the Chinese reason', () => {
    const container = render(
      createElement(PublicStateNotice, {
        failure: classifyPublicError(apiError(403, 'FORBIDDEN')),
        onRecover: () => undefined,
      }),
    )
    expect(container.querySelector('[data-testid="public-state-recover"]')).toBeNull()
    expect(container.querySelector('[data-testid="public-state-reason"]')?.textContent).toContain('权限')
  })

  it('lists named capability gaps', () => {
    const container = render(
      createElement(PublicStateNotice, {
        failure: classifyPublicError(apiError(409, 'CAPABILITY_NOT_CONFIGURED', { missingCapabilities: ['pricing.compute'] })),
      }),
    )
    const gap = container.querySelector('[data-testid="public-state-capability"]')
    expect(gap?.getAttribute('data-capability')).toBe('pricing.compute')
  })
})

describe('PublicEmptyState writes what is required and the next step', () => {
  it('renders the requirement and next step', () => {
    const container = render(
      createElement(PublicEmptyState, {
        requirement: '一份已发布的行业包版本',
        nextStep: '创建一个项目',
      }),
    )
    expect(container.querySelector('[data-testid="public-empty"]')?.getAttribute('data-state')).toBe('empty')
    expect(container.querySelector('[data-testid="public-empty-requirement"]')?.textContent).toContain('行业包')
    expect(container.querySelector('[data-testid="public-empty-next"]')?.textContent).toContain('项目')
  })
})
