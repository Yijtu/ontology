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
  await page.waitForSelector('[data-testid="definition-candidate"]')
  await page.waitForSelector('[data-testid="rule-action-candidate"]')
}

function candidate(page: Page, candidateId: string) {
  return page.locator(`[data-testid="definition-candidate"][data-candidate-id="${candidateId}"]`)
}

async function selectCandidate(page: Page, candidateId: string): Promise<void> {
  await candidate(page, candidateId).locator('button').click()
  await page.waitForSelector('.ontology-detail h3')
}

describe('definition workbench in a real browser', () => {
  it('shows candidate source/conflicts/drift, rule support and action binding from the server', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      expect(await page.locator('[data-testid="definition-candidate"]').count()).toBe(4)

      const attribute = candidate(page, harness.candidateIds.attribute)
      await selectCandidate(page, harness.candidateIds.attribute)
      expect(await attribute.getAttribute('data-kind')).toBe('attribute')
      expect(await page.locator('.ontology-detail').textContent()).toContain('单位：t')
      expect(await page.locator('.ontology-detail').textContent()).toContain('与已发布单位 kg 不一致')

      await selectCandidate(page, harness.candidateIds.pending)
      expect(await page.locator('.ontology-detail').textContent()).toContain('待确认来源')
      expect(await page.locator('.ontology-detail').textContent()).toContain('较早的工作区版本')

      await selectCandidate(page, harness.candidateIds.object)
      const definitions = await harness.client.listDefinitionCandidates(harness.workspaceId, { limit: 250 })
      expect(definitions.find((value) => value.candidateId === harness.candidateIds.object)?.sourceRefs).toHaveLength(1)

      // A genuine different-condition OR is now executable (#188), so the supported fixture
      // exercises that path while the relation premise stays outside the finite subset.
      const supported = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.supported}"]`)
      await supported.locator('button').click()
      expect(await page.locator('.ontology-detail').textContent()).toContain('有限条件可执行')
      const rules = await harness.client.listRuleActionCandidates(harness.workspaceId, { limit: 250 })
      const supportedRule = rules.find((value) => value.candidateId === harness.ruleCandidateIds.supported)
      expect(supportedRule?.payload.kind === 'rule' ? supportedRule.payload.condition.op : undefined).toBe('any')
      expect(JSON.stringify(supportedRule?.payload.kind === 'rule' ? supportedRule.payload.condition : undefined)).toContain('operating_hours')

      const rule = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.unsupported}"]`)
      await rule.locator('button').click()
      expect(await page.locator('.ontology-detail').textContent()).toContain('暂不可执行')
      const unsupportedRule = rules.find((value) => value.candidateId === harness.ruleCandidateIds.unsupported)
      expect(JSON.stringify(unsupportedRule?.payload)).toContain('relation')

      const action = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.notExecutable}"]`)
      await action.locator('button').click()
      expect(await page.locator('.ontology-detail').textContent()).toContain('尚未绑定可执行实现')
      expect(await page.locator('.ontology-detail').textContent()).toContain('OPERATION_NOT_AUTHORIZED')

      expect(await page.locator('.ontology-lifecycle').textContent()).toContain('待来源确认')

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
      await selectCandidate(page, harness.candidateIds.attribute)
      await page.getByRole('button', { name: '编辑定义', exact: true }).click()
      await page.getByLabel('单位', { exact: true }).fill('kg')
      await page.getByLabel('本次修改原因', { exact: true }).fill('统一为千克')
      await page.getByRole('button', { name: '保存为新候选', exact: true }).click()
      await page.getByText('操作已由服务端确认。新的内容需要重新确认依据并单独审核。').waitFor()
      const versions = await harness.client.listDefinitionCandidates(harness.workspaceId, { limit: 250 })
      const original = versions.find((value) => value.candidateId === harness.candidateIds.attribute)
      const edited = versions.find((value) => value.logicalId === 'capacity' && value.candidateId !== harness.candidateIds.attribute && value.payload.kind === 'attribute')
      expect(original?.payload.kind === 'attribute' ? original.payload.unitCode : undefined).toBe('t')
      expect(edited?.payload.kind === 'attribute' ? edited.payload.unitCode : undefined).toBe('kg')
      expect(edited?.contentDigest).not.toBe(original?.contentDigest)
      expect(edited).toBeDefined()
      const editedAttribute = candidate(page, edited?.candidateId ?? '')
      expect(await editedAttribute.count()).toBe(1)
      await selectCandidate(page, edited?.candidateId ?? '')
      expect(await page.locator('.ontology-detail').textContent()).toContain('单位：kg')

      // Enabling the unsupported rule is refused with the server's classified reason.
      const rule = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.ruleCandidateIds.unsupported}"]`)
      await rule.locator('button').click()
      const enable = page.getByRole('button', { name: '启用通过验核的声明', exact: true })
      expect(await enable.isDisabled()).toBe(true)
      await expectRuleEnableBlocked()

      // Rejecting a candidate preserves its payload and records a review decision.
      const pending = candidate(page, harness.candidateIds.pending)
      await pending.locator('button').click()
      await page.getByLabel('审核意见', { exact: true }).fill('无法定位来源')
      await page.getByRole('button', { name: '撤销此定义候选', exact: true }).click()
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

  async function expectRuleEnableBlocked(): Promise<void> {
    let code = ''
    try {
      await harness.client.enableRuleActionCandidate(harness.workspaceId, harness.ruleCandidateIds.unsupported, { expectedRevision: '2' })
    } catch (error) {
      code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : error instanceof Error ? error.message : String(error)
    }
    expect(code).toBe('SUPPORT_VALIDATION_BLOCKED')
  }
  })

  it('refuses a stale edit with a version conflict instead of overwriting the newer draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      const draftsBefore = await harness.client.listIndustryWorkspaceDrafts(harness.workspaceId)
      const headBefore = draftsBefore.reduce((latest, value) => BigInt(value.revision) > BigInt(latest.revision) ? value : latest).revision
      // A concurrent writer appends a draft revision after this page read the head.
      await harness.bumpWorkspaceHead()

      await selectCandidate(page, harness.candidateIds.object)
      await page.getByRole('button', { name: '编辑定义', exact: true }).click()
      await page.getByLabel('业务含义', { exact: true }).fill('过期页面的修改')
      await page.getByLabel('本次修改原因', { exact: true }).fill('基于过期修订')
      await page.getByRole('button', { name: '保存为新候选', exact: true }).click()
      await page.getByText('版本冲突').waitFor()
      expect(headBefore).toBe('2')

      await capture(page, 'definition-workbench-cas-conflict')
      await record('definition-workbench-cas-conflict', ['staleEdit=VERSION_CONFLICT', 'overwrite=false'])
    } finally {
      await context.close()
    }
  })

  it('confirms an action against real source text, requires human review, enables it and reads back', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page)
      const action = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${harness.actionCandidateIds.executable}"]`)
      await action.locator('button').click()
      expect(await page.locator('.ontology-detail').textContent()).toContain('已绑定可执行实现')
      const enable = page.getByRole('button', { name: '启用通过验核的声明', exact: true })
      expect(await enable.isDisabled()).toBe(true)
      const approve = page.getByRole('button', { name: '批准当前内容', exact: true })
      expect(await approve.isDisabled()).toBe(true)
      await page.getByRole('button', { name: '查看原始资料与定位片段', exact: true }).click()
      await page.getByRole('button', { name: '读取所选原文与真实片段', exact: true }).click()
      await page.getByLabel('原始依据', { exact: true }).getByText('构件已登记', { exact: false }).waitFor()
      const declarationEvidence = page.getByLabel('动作声明整体依据')
      const declarationEvidenceValue = await declarationEvidence.locator('option').evaluateAll((options) =>
        (options.find((option) => (option as HTMLOptionElement).value.length > 0) as HTMLOptionElement | undefined)?.value,
      )
      expect(declarationEvidenceValue).toBeDefined()
      await declarationEvidence.selectOption(declarationEvidenceValue as string)
      const preconditionEvidence = page.getByLabel('动作前提 1：构件已登记')
      await preconditionEvidence.selectOption(declarationEvidenceValue as string)
      await page.getByLabel('来源确认说明', { exact: true }).fill('根据已解析的桥架检查规程确认声明及前置条件')
      await page.getByRole('button', { name: '确认依据并生成新候选', exact: true }).click()
      await page.getByText('来源状态已由服务端记录；人工批准仅针对当前内容。').waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => candidate.textContent?.trim() === '刷新当前版本')
        return button !== undefined && !button.disabled
      })

      const confirmedVersions = await harness.client.listRuleActionCandidates(harness.workspaceId, { limit: 250 })
      const confirmed = confirmedVersions.find((value) => value.replacesCandidateId === harness.actionCandidateIds.executable)
      expect(confirmed?.payload.kind === 'action' ? confirmed.payload.binding?.executable : false).toBe(true)
      expect(confirmed?.generationContext?.issues).toHaveLength(0)
      expect(await page.locator('.ontology-candidate-list li.is-selected').getAttribute('data-candidate-id')).toBe(confirmed?.candidateId)
      await page.getByText('来源状态已由服务端记录；人工批准仅针对当前内容。').waitFor()
      await page.getByText('当前候选还没有人工审核记录。', { exact: true }).waitFor()
      expect(await enable.isDisabled()).toBe(true)

      const reviewOpinion = '已逐项核对真实来源、只读作用与注册能力绑定'
      const reviewInput = page.getByLabel('审核意见', { exact: true })
      await reviewInput.fill(reviewOpinion)
      expect(await reviewInput.inputValue()).toBe(reviewOpinion)
      expect(await approve.isEnabled()).toBe(true)
      await approve.click()
      await page.getByText(/当前内容已批准/).waitFor()
      expect(await enable.isEnabled()).toBe(true)
      await enable.click()
      await page.waitForSelector(`[data-testid="rule-action-candidate"][data-candidate-id="${confirmed?.candidateId ?? ''}"][data-state="enabled"]`)

      await page.reload()
      await page.waitForSelector(`[data-testid="rule-action-candidate"][data-candidate-id="${confirmed?.candidateId ?? ''}"][data-state="enabled"]`)

      await capture(page, 'definition-workbench-action-enabled')
      await record('definition-workbench-action-enabled', ['realSourceConfirmation=true', 'humanReview=approved', 'actionBinding=executable', 'actionLifecycle=enabled', 'readback=ok'])
    } finally {
      await context.close()
    }
  })

  it('hides the edit/reject/merge entry points for a readonly principal', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page, '&case=readonly')
      await selectCandidate(page, harness.candidateIds.object)
      expect(await page.getByRole('button', { name: '编辑定义', exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '撤销此定义候选', exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '批准当前内容', exact: true }).count()).toBe(0)
      await capture(page, 'definition-workbench-readonly')
      await record('definition-workbench-readonly', ['editButtons=0', 'unsupportedForm=0'])
    } finally {
      await context.close()
    }
  })
})
