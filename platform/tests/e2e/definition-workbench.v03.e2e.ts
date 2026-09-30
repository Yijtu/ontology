import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startDefinitionWorkbenchHarness } from '../ui/definition-workbench-fixtures'
import type { DefinitionWorkbenchHarness } from '../ui/definition-workbench-fixtures'

/**
 * Real-browser E2E for the definition / rule / action review workbench (V03-012 / #185,
 * SPEC v0.3a §9.1/§9.2). The built `definition-workbench-harness.html` composition mounts the
 * V03-022 shell with the workbench as the ontology home. The loopback static host proxies `/api`
 * to a real Fastify server over in-memory stores, so the page exercises candidate listing with
 * source/conflicts, an edit that appends a revision, a reject, an unsupported rule and an
 * unbound/executable action binding over actual HTTP.
 */

let harness: DefinitionWorkbenchHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startDefinitionWorkbenchHarness()
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.close().catch(() => undefined)
})

async function openPanel(page: Page, query = ''): Promise<void> {
  await page.goto(`${web.origin}/definition-workbench-harness.html?workspace=${harness.workspaceId}${query}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="definition-workbench"]')
  await page.waitForSelector('[data-testid="definition-candidates"]')
  await page.waitForSelector('[data-testid="rule-action-candidates"]')
}

function candidate(page: Page, candidateId: string) {
  return page.locator(`[data-testid="definition-candidate"][data-candidate-id="${candidateId}"]`)
}

describe('definition workbench in a real browser', () => {
  it('shows candidate source/conflicts/drift, rule support and action binding from the server', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      expect(await page.locator('[data-testid="definition-candidate"]').count()).toBe(4)

      const attribute = candidate(page, harness.candidateIds.attribute)
      expect(await attribute.getAttribute('data-kind')).toBe('attribute')
      expect(await attribute.locator('[data-testid="definition-candidate-detail"]').textContent()).toContain('单位：t')
      expect(await attribute.locator('[data-testid="definition-candidate-conflict"]').textContent()).toContain('unit_conflict')

      const pending = candidate(page, harness.candidateIds.pending)
      expect(await pending.locator('[data-testid="definition-candidate-pending"]').count()).toBe(1)
      expect(await pending.getAttribute('data-stale')).toBe('true')

      const object = candidate(page, harness.candidateIds.object)
      expect(await object.locator('[data-testid="definition-candidate-source"]').textContent()).toContain('1 项')

      // A genuine different-condition OR is now executable (#188), so the supported fixture
      // exercises that path while the relation premise stays outside the finite subset.
      const supported = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.supported}"]`)
      expect(await supported.getAttribute('data-support')).toBe('executable')
      expect(await supported.locator('[data-testid="rule-condition"]').textContent()).toContain('operating_hours')

      const rule = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.unsupported}"]`)
      expect(await rule.getAttribute('data-support')).toBe('not_yet_executable')
      expect(await rule.locator('[data-testid="rule-support"]').textContent()).toContain('暂不可执行')
      expect(await rule.locator('[data-testid="rule-condition"]').textContent()).toContain('relation')

      const action = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.notExecutable}"]`)
      expect(await action.getAttribute('data-binding')).toBe('not_executable')
      expect(await action.locator('[data-testid="action-binding-finding"]').first().textContent()).toContain('OPERATION_NOT_AUTHORIZED')

      expect(await page.locator('[data-testid="unsupported-rule"]').first().getAttribute('data-executable')).toBe('false')
      expect(await page.locator('[data-testid="generation-batch"]').first().getAttribute('data-stale')).toBe('true')

      await capture(page, 'definition-workbench-overview')
      await record('definition-workbench-overview', [
        'candidates=4',
        'attributeUnit=t',
        'pendingConfirmation=1',
        'candidateStale=true',
        'supportedRuleSupport=executable',
        'unsupportedRuleSupport=not_yet_executable',
        'actionBinding=not_executable',
      ])
    } finally {
      await context.close()
    }
  })

  it('edits a unit into a new candidate revision, blocks the unsupported rule, and rejects a candidate', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)

      // Edit the attribute unit: a new immutable candidate revision is appended.
      const attribute = candidate(page, harness.candidateIds.attribute)
      await attribute.locator('[data-testid="definition-candidate-edit-start"]').click()
      await page.waitForSelector('[data-testid="definition-candidate-edit-form"]')
      await page.fill('[data-testid="definition-edit-unit"]', 'kg')
      await page.fill('[data-testid="definition-edit-reason"]', '统一为千克')
      await page.click('[data-testid="definition-edit-submit"]')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="definition-candidate"]').length === 5,
      )
      const editedAttribute = page
        .locator('[data-testid="definition-candidate"][data-kind="attribute"]')
        .filter({ hasText: '单位：kg' })
      expect(await editedAttribute.count()).toBe(1)
      expect(await page.locator('[data-testid="definition-adjudication"][data-kind="edit"]').count()).toBe(1)
      // The original candidate is preserved (not mutated in place).
      expect(await candidate(page, harness.candidateIds.attribute).locator('[data-testid="definition-candidate-detail"]').textContent()).toContain('单位：t')

      // Enabling the unsupported rule is refused with the server's classified reason.
      const rule = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.unsupported}"]`)
      await rule.locator('[data-testid="rule-action-enable"]').click()
      await page.waitForSelector('[data-testid="definition-action-failure"][data-code="SUPPORT_VALIDATION_BLOCKED"]')
      expect(await rule.getAttribute('data-lifecycle')).toBe('draft')

      // Rejecting a candidate preserves its payload and records a review decision.
      const pending = candidate(page, harness.candidateIds.pending)
      await pending.locator('[data-testid="definition-candidate-reject-start"]').click()
      await page.waitForSelector('[data-testid="definition-reject-form"]')
      await page.fill('[data-testid="definition-reject-reason"]', '无法定位来源')
      await page.click('[data-testid="definition-reject-submit"]')
      await page.waitForSelector(`[data-testid="definition-candidate"][data-candidate-id="${harness.candidateIds.pending}"][data-state="rejected"]`)

      await capture(page, 'definition-workbench-edit-reject')
      await record('definition-workbench-edit-reject', [
        'editAppendedRevision=true',
        'originalPreserved=true',
        'unsupportedRuleEnable=SUPPORT_VALIDATION_BLOCKED',
        'rejectedState=rejected',
      ])
    } finally {
      await context.close()
    }
  })

  it('refuses a stale edit with a version conflict instead of overwriting the newer draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      const headBefore = await page.textContent('[data-testid="definition-head-revision"]')
      // A concurrent writer appends a draft revision after this page read the head.
      await harness.bumpWorkspaceHead()

      const object = candidate(page, harness.candidateIds.object)
      await object.locator('[data-testid="definition-candidate-edit-start"]').click()
      await page.waitForSelector('[data-testid="definition-candidate-edit-form"]')
      await page.fill('[data-testid="definition-edit-business-meaning"]', '过期页面的修改')
      await page.fill('[data-testid="definition-edit-reason"]', '基于过期修订')
      await page.click('[data-testid="definition-edit-submit"]')
      await page.waitForSelector('[data-testid="definition-action-failure"][data-code="VERSION_CONFLICT"]')
      expect(headBefore).toContain('2')

      await capture(page, 'definition-workbench-cas-conflict')
      await record('definition-workbench-cas-conflict', ['staleEdit=VERSION_CONFLICT', 'overwrite=false'])
    } finally {
      await context.close()
    }
  })

  it('enables an action bound to a registered capability and reads the lifecycle back after refresh', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      const action = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.executable}"]`)
      expect(await action.getAttribute('data-binding')).toBe('executable')
      await action.locator('[data-testid="rule-action-enable"]').click()
      await page.waitForSelector(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.executable}"][data-lifecycle="enabled"]`)

      await page.reload()
      await page.waitForSelector('[data-testid="rule-action-candidates"]')
      await page.waitForSelector(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.executable}"][data-lifecycle="enabled"]`)

      await capture(page, 'definition-workbench-action-enabled')
      await record('definition-workbench-action-enabled', ['actionBinding=executable', 'actionLifecycle=enabled', 'readback=ok'])
    } finally {
      await context.close()
    }
  })

  it('hides the edit/reject/merge entry points for a readonly principal', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page, '&case=readonly')
      expect(await page.locator('[data-testid="definition-candidate-edit-start"]').count()).toBe(0)
      expect(await page.locator('[data-testid="definition-candidate-reject-start"]').count()).toBe(0)
      expect(await page.locator('[data-testid="unsupported-rule-form"]').count()).toBe(0)
      await capture(page, 'definition-workbench-readonly')
      await record('definition-workbench-readonly', ['editButtons=0', 'unsupportedForm=0'])
    } finally {
      await context.close()
    }
  })
})
