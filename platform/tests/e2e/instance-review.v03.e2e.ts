import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { INSTANCE_REVIEW_PROJECT_ID, startInstanceReviewHarness } from '../ui/instance-review-fixtures'
import type { InstanceReviewHarness } from '../ui/instance-review-fixtures'

/**
 * Real-browser E2E for the public instance review surface (V03-013 / #182, SPEC v0.3a
 * §9.1/§9.2). The built `instance-review-harness.html` composition mounts the V03-022 shell
 * with the instance review panel as the ontology home. The loopback static host proxies `/api`
 * to a real Fastify server over the in-memory store, so the page exercises key-field
 * confirmation, identity adjudication, approval/publication and read-back over actual HTTP.
 */

let harness: InstanceReviewHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startInstanceReviewHarness()
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.close().catch(() => undefined)
})

async function openPanel(page: Page): Promise<void> {
  await page.goto(`${web.origin}/instance-review-harness.html?project=${INSTANCE_REVIEW_PROJECT_ID}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="instance-review"]')
  await page.waitForSelector('[data-testid="instance-record-list"]')
}

async function selectRecord(page: Page, recordId: string): Promise<void> {
  await page.locator(`[data-testid="instance-record-item"][data-record-id="${recordId}"]`).click()
  await page.waitForSelector(`[data-testid="instance-detail"][data-record-id="${recordId}"]`)
}

function fieldRow(page: Page, fieldId: string) {
  return page.locator(`[data-testid="instance-field-row"][data-field-id="${fieldId}"]`)
}

describe('instance review in a real browser', () => {
  it('shows raw/normalized/source/status, identity confidence and a same-name/different-object flag', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      await selectRecord(page, harness.recordIds.main)

      expect(await page.textContent('[data-testid="instance-detail-object-type"]')).toBe('device')
      expect(await page.textContent('[data-testid="instance-identity-confidence"]')).toContain('exact')
      expect(await page.textContent('[data-testid="instance-identity-same-name"]')).toContain('是')

      const nameRow = fieldRow(page, 'device_name')
      expect(await nameRow.locator('[data-testid="instance-field-raw"]').textContent()).toBe('Bridge A')
      expect(await nameRow.locator('[data-testid="instance-field-normalized"]').textContent()).toBe('Bridge A')
      expect(await nameRow.locator('[data-testid="instance-field-source"]').textContent()).toContain('json_pointer')
      expect(
        await nameRow.locator('[data-testid="instance-field-status"]').getAttribute('data-status'),
      ).toBe('pending')

      const capacityRow = fieldRow(page, 'capacity')
      expect(await capacityRow.locator('[data-testid="instance-field-normalized"]').textContent()).toBe('10.5 kW')

      const relation = page.locator('[data-testid="instance-relation-row"]').first()
      expect(await relation.getAttribute('data-endpoint-state')).toBe('resolved')

      await capture(page, 'instance-review-overview')
      await record('instance-review-overview', [
        'identityConfidence=exact',
        'sameNameDifferentMeaning=yes',
        'field.device_name=pending',
        'relation.r-main=resolved',
      ])
    } finally {
      await context.close()
    }
  })

  it('confirms a field, records a conflict and a rejection, and re-enters pending after an edit', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      await selectRecord(page, harness.recordIds.main)

      await fieldRow(page, 'device_name').locator('[data-testid="instance-field-confirm"]').click()
      await page.waitForSelector('[data-testid="instance-field-row"][data-field-id="device_name"] [data-testid="instance-field-status"][data-status="confirmed"]')

      await fieldRow(page, 'capacity').locator('[data-testid="instance-field-conflict"]').click()
      await page.waitForSelector('[data-testid="instance-field-row"][data-field-id="capacity"] [data-testid="instance-field-status"][data-status="conflict"]')

      await fieldRow(page, 'capacity').locator('[data-testid="instance-field-confirm"]').click()
      await page.waitForSelector('[data-testid="instance-field-row"][data-field-id="capacity"] [data-testid="instance-field-status"][data-status="confirmed"]')

      // Modify the value: the field re-enters pending and must be re-checked.
      await fieldRow(page, 'device_name').locator('[data-testid="instance-field-edit-start"]').click()
      await page.waitForSelector('[data-testid="instance-field-edit-form"]')
      await page.fill('[data-testid="instance-field-edit-input"]', 'Bridge B')
      await page.fill('[data-testid="instance-field-edit-reason"]', '来源显示新值')
      await page.click('[data-testid="instance-field-edit-submit"]')
      await page.waitForSelector('[data-testid="instance-field-row"][data-field-id="device_name"] [data-testid="instance-field-status"][data-status="pending"]')
      expect(await fieldRow(page, 'device_name').locator('[data-testid="instance-field-normalized"]').textContent()).toBe('Bridge B')

      await fieldRow(page, 'device_name').locator('[data-testid="instance-field-confirm"]').click()
      await page.waitForSelector('[data-testid="instance-field-row"][data-field-id="device_name"] [data-testid="instance-field-status"][data-status="confirmed"]')

      await capture(page, 'instance-review-field-confirmation')
      await record('instance-review-field-confirmation', [
        'device_name=confirmed',
        'capacity=confirmed',
        'editReenteredPending=yes',
        'editReason=来源显示新值',
      ])
    } finally {
      await context.close()
    }
  })

  it('adjudicates identity, blocks a cross-object match, approves and publishes with read-back', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      await selectRecord(page, harness.recordIds.main)

      const deviceCandidate = page
        .locator('[data-testid="instance-identity-candidate"]')
        .filter({ hasText: 'device · native_id' })
      await deviceCandidate.locator('[data-testid="instance-identity-match"]').click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('matched'),
      )

      // Matching a sensor candidate (a different object) is refused with a visible conflict.
      const sensorCandidate = page
        .locator('[data-testid="instance-identity-candidate"]')
        .filter({ hasText: 'sensor · context' })
      await sensorCandidate.locator('[data-testid="instance-identity-match"]').click()
      await page.waitForSelector('[data-testid="instance-action-failure"][data-code="IDENTITY_CONFLICT"]')

      await page.click('[data-testid="instance-identity-split"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('split'),
      )

      await page.fill('[data-testid="instance-identity-reason"]', '确认新实体')
      await page.click('[data-testid="instance-identity-create"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('created'),
      )

      await page.click('[data-testid="instance-approve"]')
      await page.waitForSelector('[data-testid="instance-detail-publication"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === 'approved',
      )

      await page.click('[data-testid="instance-publish"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === 'published',
      )
      const publishedRevision = await page.textContent('[data-testid="instance-detail-published-revision"]')
      expect(publishedRevision).not.toBe('—')

      // An ordinary refresh reads the same published revision back from the server.
      await page.reload()
      await page.waitForSelector('[data-testid="instance-record-list"]')
      await selectRecord(page, harness.recordIds.main)
      expect(await page.textContent('[data-testid="instance-detail-publication"]')).toBe('published')
      expect(await page.textContent('[data-testid="instance-detail-published-revision"]')).toBe(publishedRevision)

      await capture(page, 'instance-review-published')
      await record('instance-review-published', [
        'identityState=created',
        'crossObjectMatch=IDENTITY_CONFLICT',
        `publishedRevision=${publishedRevision ?? ''}`,
        'readback=ok',
      ])
    } finally {
      await context.close()
    }
  })

  it('blocks approval while a relation endpoint is still pending', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      await selectRecord(page, harness.recordIds.pendingRelation)
      const relation = page.locator('[data-testid="instance-relation-row"]').first()
      expect(await relation.getAttribute('data-endpoint-state')).toBe('pending')
      await page.click('[data-testid="instance-approve"]')
      await page.waitForSelector('[data-testid="instance-action-failure"][data-code="PUBLICATION_BLOCKED"]')
      await capture(page, 'instance-review-pending-relation')
      await record('instance-review-pending-relation', ['relation.r-pending=pending', 'approve=PUBLICATION_BLOCKED'])
    } finally {
      await context.close()
    }
  })

  it('merges two records onto one entity without deleting either business record', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      const beforeCount = await page.locator('[data-testid="instance-record-item"]').count()
      await selectRecord(page, harness.recordIds.duplicate)
      const deviceCandidate = page
        .locator('[data-testid="instance-identity-candidate"]')
        .filter({ hasText: 'device · native_id' })
      await deviceCandidate.locator('[data-testid="instance-identity-match"]').click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('matched'),
      )
      const afterCount = await page.locator('[data-testid="instance-record-item"]').count()
      expect(afterCount).toBe(beforeCount)
      expect(await page.locator(`[data-testid="instance-record-item"][data-record-id="${harness.recordIds.main}"]`).count()).toBe(1)
      expect(await page.locator(`[data-testid="instance-record-item"][data-record-id="${harness.recordIds.duplicate}"]`).count()).toBe(1)
      await capture(page, 'instance-review-merge')
      await record('instance-review-merge', [`recordsBefore=${String(beforeCount)}`, `recordsAfter=${String(afterCount)}`, 'mergeKeepsBothRecords=yes'])
    } finally {
      await context.close()
    }
  })
})
