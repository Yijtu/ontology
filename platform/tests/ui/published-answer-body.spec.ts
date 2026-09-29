// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DraftClaim, PublishedAnswer, ResourceRef, VerifiedAssertion } from '@ontology/contracts'
import { PublishedAnswerBody } from '../../apps/web/src/components/PublishedAnswerBody'

const ANSWER_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const DRAFT_ID = '33333333-3333-4333-8333-333333333333'
const VERIFICATION_ID = '44444444-4444-4444-8444-444444444444'
const CLAIM_ID = '55555555-5555-4555-8555-555555555555'
const ASSERTION_ID = '66666666-6666-4666-8666-666666666666'
const QUOTE_ID = '77777777-7777-4777-8777-777777777777'
const RULE_ASSERTION_ID = '88888888-8888-4888-8888-888888888888'
const BUSINESS_ASSERTION_ID = '99999999-9999-4999-8999-999999999999'
const EVIDENCE: ResourceRef = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'evidence',
}
const DOCUMENT: ResourceRef = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
  kind: 'document',
}
const DIGEST_A = `sha256:${'c'.repeat(64)}`
const DIGEST_B = `sha256:${'d'.repeat(64)}`

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = []

function claim(overrides: Partial<DraftClaim> = {}): DraftClaim {
  return {
    claimId: CLAIM_ID,
    subject: 'entity.device-17',
    predicate: 'operation_hours',
    value: { value: '100.000000000000000001', unit: 'h' },
    time: { asOf: '2026-09-28T00:00:00Z' },
    kind: 'observation',
    references: [{
      evidenceRef: EVIDENCE,
      resultDigest: DIGEST_A,
      valuePointer: '/table/rows/0/0',
      unitPointer: '/table/columns/0/unit',
      subjectPointer: '/table/rows/0/1',
    }],
    ...overrides,
  }
}

function booleanAssertion(
  overrides: Partial<Extract<VerifiedAssertion, { readonly kind: 'boolean' }>> = {},
): VerifiedAssertion {
  return {
    assertionId: ASSERTION_ID,
    kind: 'boolean',
    subject: 'entity.device-17',
    predicate: 'available',
    value: false,
    references: [{
      evidenceRef: EVIDENCE,
      resultDigest: DIGEST_A,
      valuePointer: '/available',
      subjectPointer: '/device_id',
    }],
    ...overrides,
  }
}

function answer(overrides: Partial<PublishedAnswer> = {}): PublishedAnswer {
  return {
    answerId: ANSWER_ID,
    runId: RUN_ID,
    draftId: DRAFT_ID,
    verificationId: VERIFICATION_ID,
    contentHash: DIGEST_A,
    evidenceManifestHash: DIGEST_B,
    scenarioManifestHash: `sha256:${'e'.repeat(64)}`,
    publicationKind: 'verified',
    limitations: [],
    body: {
      schemaVersion: 'answer-draft@2',
      blocks: [],
      claims: [],
      assertions: [],
    },
    publishedAt: '2026-09-28T00:00:00Z',
    ...overrides,
  }
}

async function render(
  value: PublishedAnswer,
  props: { readonly resolveLabel?: (id: string, kind: 'subject' | 'predicate') => string | undefined; readonly onEvidenceReference?: (ref: ResourceRef) => void } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(PublishedAnswerBody, { answer: value, ...props }))
  })
  mounted.push({ root, container })
  return container
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('PublishedAnswerBody', () => {
  it('renders bound decimal quantities and boolean false without float coercion, with clickable evidence refs', async () => {
    const evidenceClick = vi.fn<(ref: ResourceRef) => void>()
    const body = {
      schemaVersion: 'answer-draft@2' as const,
      blocks: [
        { kind: 'claim', claimId: CLAIM_ID },
        { kind: 'assertion', assertionId: ASSERTION_ID },
      ],
      claims: [claim()],
      assertions: [booleanAssertion()],
    }
    const container = await render(answer({ body }), {
      resolveLabel: (id, kind) => {
        if (kind === 'subject' && id === 'entity.device-17') return '设备 T-17'
        if (kind === 'predicate' && id === 'operation_hours') return '运行时长'
        return undefined
      },
      onEvidenceReference: evidenceClick,
    })

    expect(container.querySelector('[data-testid="published-answer-quantity"]')?.textContent)
      .toBe('100.000000000000000001')
    expect(container.querySelector('[data-testid="published-answer-unit"]')?.textContent).toBe('h')
    expect(container.querySelector('[data-kind="claim"]')?.textContent).toContain('设备 T-17 · 运行时长')
    expect(container.querySelector('[data-testid="published-answer-boolean"]')?.textContent).toBe('否')
    expect(container.textContent).not.toContain(EVIDENCE.id)

    const source = container.querySelector('[data-testid="published-answer-evidence-reference"]')
    expect(source).not.toBeNull()
    if (source === null) throw new Error('evidence source button is missing')
    await click(source)
    expect(evidenceClick).toHaveBeenCalledWith(EVIDENCE)
  })

  it('renders the exact quote as escaped source text', async () => {
    const quote = '<img src=x onerror=alert(1)>原文中的精确引句'
    const assertion: VerifiedAssertion = {
      assertionId: QUOTE_ID,
      kind: 'document_quote',
      subject: 'entity.device-17',
      predicate: 'inspection_note',
      quote,
      documentRef: DOCUMENT,
      locator: { kind: 'page', page: 4 },
      quoteDigest: DIGEST_A,
      textDigest: DIGEST_B,
      precision: 'exact',
      references: [{
        evidenceRef: EVIDENCE,
        resultDigest: DIGEST_A,
        valuePointer: '/quote',
        subjectPointer: '/subject',
      }],
    }
    const container = await render(answer({
      body: {
        schemaVersion: 'answer-draft@2',
        blocks: [{ kind: 'assertion', assertionId: QUOTE_ID }],
        claims: [],
        assertions: [assertion],
      },
    }))

    expect(container.querySelector('[data-testid="published-answer-quote"]')?.textContent).toBe(quote)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-kind="document_quote"]')?.textContent).toContain('精确引文')
  })

  it('does not render prose or extra fields from invalid and unsupported V2 blocks', async () => {
    const container = await render(answer({
      body: {
        schemaVersion: 'answer-draft@2',
        blocks: [
          { kind: 'claim', claimId: CLAIM_ID, text: 'BLOCK_PROSE_SENTINEL' },
          { kind: 'text', text: 'MODEL_PROSE_SENTINEL' },
          'UNKNOWN_BLOCK_SENTINEL',
        ],
        claims: [claim()],
        assertions: [],
      },
    }))

    expect(container.textContent).not.toContain('BLOCK_PROSE_SENTINEL')
    expect(container.textContent).not.toContain('MODEL_PROSE_SENTINEL')
    expect(container.textContent).not.toContain('UNKNOWN_BLOCK_SENTINEL')
    expect(container.querySelectorAll('[data-testid="published-answer-statement"]')).toHaveLength(0)
    expect(container.querySelector('[data-testid="published-answer-omitted-content"]')?.textContent)
      .toContain('已省略')
  })

  it('does not invent a conclusion when the referenced typed item is missing or has no evidence binding', async () => {
    const unreferenced = booleanAssertion({
      assertionId: ASSERTION_ID,
      value: true,
      predicate: 'requires_action',
      references: [],
    })
    const container = await render(answer({
      body: {
        schemaVersion: 'answer-draft@2',
        blocks: [
          { kind: 'claim', claimId: CLAIM_ID },
          { kind: 'assertion', assertionId: ASSERTION_ID },
        ],
        claims: [],
        assertions: [unreferenced],
      },
    }))

    expect(container.textContent).not.toContain('requires_action')
    expect(container.querySelectorAll('[data-testid="published-answer-statement"]')).toHaveLength(0)
    expect(container.querySelector('[data-testid="published-answer-no-structured-content"]')?.textContent)
      .toContain('没有可安全展示')
    expect(container.querySelector('[data-testid="published-answer-omitted-content"]')).not.toBeNull()
  })

  it('keeps rule status separate from the typed business conclusion', async () => {
    const ruleJudgement: VerifiedAssertion = {
      assertionId: RULE_ASSERTION_ID,
      kind: 'rule_judgement',
      subject: 'entity.device-17',
      predicate: 'rule.maintenance_applicability',
      value: 'false',
      ruleRef: { id: 'rule.maintenance', version: '1.0.0', digest: DIGEST_A },
      premiseRefs: [EVIDENCE],
      references: [{ evidenceRef: EVIDENCE, resultDigest: DIGEST_A, valuePointer: '/applicable', subjectPointer: '/device' }],
    }
    const businessConclusion: VerifiedAssertion = {
      assertionId: BUSINESS_ASSERTION_ID,
      kind: 'boolean',
      subject: 'entity.device-17',
      predicate: 'maintenance_required',
      value: true,
      references: [{ evidenceRef: EVIDENCE, resultDigest: DIGEST_A, valuePointer: '/required', subjectPointer: '/device' }],
    }
    const container = await render(answer({
      body: {
        schemaVersion: 'answer-draft@2',
        blocks: [
          { kind: 'assertion', assertionId: RULE_ASSERTION_ID },
          { kind: 'assertion', assertionId: BUSINESS_ASSERTION_ID },
        ],
        claims: [],
        assertions: [ruleJudgement, businessConclusion],
      },
    }))

    expect(container.querySelector('[data-testid="published-answer-rule-judgement"]')?.textContent)
      .toContain('规则判定（非业务结论）：false')
    expect(container.querySelector('[data-testid="published-answer-rule-judgement"]')?.textContent)
      .toContain('entity.device-17 · rule.maintenance_applicability')
    expect(container.querySelector('[data-testid="published-answer-boolean"]')?.textContent).toBe('是')
    expect(container.textContent).not.toContain('不需要')
  })

  it('marks historical limited answers and renders unknown limitations only as restrictions', async () => {
    const container = await render(answer({
      publicationKind: 'history_limited',
      asOf: '2026-09-20T00:00:00Z',
      limitations: ['stale_source', 'future_unknown_limit'],
    }))

    expect(container.querySelector('[data-testid="published-answer-as-of"]')?.textContent)
      .toContain('2026-09-20T00:00:00Z')
    const limitations = [...container.querySelectorAll('[data-testid="published-answer-limitation"]')]
      .map((item) => item.textContent ?? '')
    expect(limitations[0]).toContain('证据已过期')
    expect(limitations[1]).toContain('不是业务结论')
    expect(container.querySelector('[data-testid="published-answer-limitation"] code')?.textContent)
      .toBe('future_unknown_limit')
  })

  it('shows only safe details from a legacy summary and never echoes free prose', async () => {
    const container = await render(answer({
      body: {
        schemaVersion: 'answer-draft@1',
        blocks: [
          { kind: 'summary', question: 'LEGACY_QUESTION_SENTINEL', evidenceCount: 3, deficits: ['DEFICIT_SENTINEL'], limitations: [] },
          { kind: 'text', text: 'LEGACY_FREE_PROSE_SENTINEL' },
        ],
        claims: [],
        assertions: [],
      },
    }))

    expect(container.querySelector('[data-testid="published-answer-legacy-evidence-count"]')?.textContent)
      .toContain('3')
    expect(container.textContent).toContain('旧版正文格式')
    expect(container.textContent).not.toContain('LEGACY_QUESTION_SENTINEL')
    expect(container.textContent).not.toContain('DEFICIT_SENTINEL')
    expect(container.textContent).not.toContain('LEGACY_FREE_PROSE_SENTINEL')
    expect(container.querySelector('[data-testid="published-answer-omitted-content"]')).not.toBeNull()
  })

  it('clearly marks metadata-only historical answers with no body', async () => {
    const withBody = answer({ bodyUnavailableReason: 'legacy_metadata_only' })
    const { body: removedBody, ...metadataOnly } = withBody
    void removedBody
    const container = await render(metadataOnly)

    expect(container.querySelector('[data-testid="published-answer-body-unavailable"]')?.textContent)
      .toContain('只有发布元数据，没有可读取的正文')
    expect(container.querySelector('[data-testid="published-answer-content"]')).toBeNull()
  })

  it('renders unknown limitation codes as bounded text rather than business assertions', async () => {
    const longUnknownCode = `unknown_${'x'.repeat(200)}`
    const container = await render(answer({ limitations: [longUnknownCode] }))
    const limitation = container.querySelector('[data-testid="published-answer-limitation"]')

    expect(limitation?.textContent).toContain('未识别的限制')
    expect(limitation?.textContent).toContain('不是业务结论')
    expect(limitation?.textContent?.length).toBeLessThan(180)
  })
})
