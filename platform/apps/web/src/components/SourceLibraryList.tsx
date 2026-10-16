import { useState } from 'react'
import type { ResourceRef, SourceTrustTier } from '@ontology/contracts'
import type { CandidateSourceReviewState, SourceLibraryEntry } from '../api/source-library'
import { TRUST_TIER_LABELS } from '../api/source-library'
import { Button, Field, StatusBadge } from './ui'
import './ontology/ontology.css'

/**
 * The 来源库 list (design §1.5 行业「来源」页 / N06). Each row keeps the four axes apart — 来源类别
 * (four-level trust tier), 审核状态, 解析状态 and 纳入状态 — so a source that merely parsed, or merely
 * passed a web review, is never presented as an authoritative business fact. The review form is
 * local-state so a server conflict or a reload keeps the reviewer's in-progress reason and choice.
 *
 * Accepting a source and raising its 来源类别 are deliberately two separate controls (design §7):
 * the review only records 审核状态, while a promotion is a distinct, platform-admin operation. The
 * promotion control is shown but the server refuses a caller without the role, so the UI never
 * pretends the reviewer may promote.
 */
export interface SourceReviewSubmission {
  readonly reviewState: CandidateSourceReviewState
  readonly reason: string
}

export interface SourcePromotionSubmission {
  readonly nextTrustTier: SourceTrustTier
  readonly reason: string
}

export interface SourceLibraryListProps {
  readonly entries: readonly SourceLibraryEntry[]
  readonly readOnly: boolean
  readonly busy: boolean
  readonly reviewBusyId: string | undefined
  readonly onReview: (entry: SourceLibraryEntry, submission: SourceReviewSubmission) => void
  readonly onPromote: (entry: SourceLibraryEntry, submission: SourcePromotionSubmission) => void
  readonly onPreview: (ref: ResourceRef) => void
}

function SourceReviewForm({ entry, busy, onSubmit }: {
  readonly entry: SourceLibraryEntry
  readonly busy: boolean
  readonly onSubmit: (submission: SourceReviewSubmission) => void
}) {
  const candidate = entry.candidate
  const [reviewState, setReviewState] = useState<CandidateSourceReviewState>('approved')
  const [reason, setReason] = useState('')
  if (candidate === undefined) return null
  const submit = busy || reason.trim().length === 0
  return (
    <fieldset className="ontology-checks" data-testid={`source-review-${candidate.sourceId}`}>
      <legend>来源审核 · {candidate.sourceId}</legend>
      <p className="ontology-hint">审核只记录审核状态，不会改变来源类别：接受一份网页不会让它自动成为公共标准。类别提升是下方单独的、需管理员权限的操作。</p>
      <label>
        <input type="radio" name={`review-state-${candidate.sourceId}`} value="approved" checked={reviewState === 'approved'} disabled={busy}
          onChange={() => setReviewState('approved')} />
        <span>接受，允许进入建模候选</span>
      </label>
      <label>
        <input type="radio" name={`review-state-${candidate.sourceId}`} value="rejected" checked={reviewState === 'rejected'} disabled={busy}
          onChange={() => setReviewState('rejected')} />
        <span>拒绝，不纳入建模</span>
      </label>
      <Field label="审核理由" hint="必填；作为追加的审核事件记录，不覆盖历史。">
        {(attributes) => <input {...attributes} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />}
      </Field>
      <Button variant="primary" disabled={submit} data-testid={`source-review-submit-${candidate.sourceId}`}
        onClick={() => onSubmit({ reviewState, reason: reason.trim() })}>提交来源审核</Button>
    </fieldset>
  )
}

function SourcePromotionForm({ entry, busy, onSubmit }: {
  readonly entry: SourceLibraryEntry
  readonly busy: boolean
  readonly onSubmit: (submission: SourcePromotionSubmission) => void
}) {
  const candidate = entry.candidate
  const [nextTrustTier, setNextTrustTier] = useState<SourceTrustTier>(candidate?.trustTier ?? 'agent_researched')
  const [reason, setReason] = useState('')
  if (candidate === undefined) return null
  const submit = busy || reason.trim().length === 0 || nextTrustTier === candidate.trustTier
  return (
    <fieldset className="ontology-checks" data-testid={`source-promotion-${candidate.sourceId}`}>
      <legend>提升来源类别（需管理员）· {candidate.sourceId}</legend>
      <p className="ontology-hint">提升来源类别是单独、需平台管理员权限且可审计的操作；它不改变审核状态。只列出契约允许的四级，模型不能代替人工确认。</p>
      <Field label="目标来源类别">
        {(attributes) => (
          <select {...attributes} value={nextTrustTier} disabled={busy}
            onChange={(event) => setNextTrustTier(event.target.value as SourceTrustTier)}>
            {(Object.keys(TRUST_TIER_LABELS) as SourceTrustTier[]).map((tier) => (
              <option key={tier} value={tier}>{TRUST_TIER_LABELS[tier]}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="提升理由" hint="必填；记录为一条追加事件，保留何时、由谁提升类别。">
        {(attributes) => <input {...attributes} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />}
      </Field>
      <Button variant="secondary" disabled={submit} data-testid={`source-promotion-submit-${candidate.sourceId}`}
        onClick={() => onSubmit({ nextTrustTier, reason: reason.trim() })}>提升来源类别</Button>
    </fieldset>
  )
}

export function SourceLibraryList({ entries, readOnly, busy, reviewBusyId, onReview, onPromote, onPreview }: SourceLibraryListProps) {
  if (entries.length === 0) return null
  return (
    <ul className="ontology-library" data-testid="source-library-list">
      {entries.map((entry) => (
        <li key={entry.key} className="ontology-source-card" data-testid="source-library-entry" data-source-key={entry.key}
          data-kind={entry.candidate?.kind ?? 'upload'} data-review={entry.candidate?.reviewState ?? 'unrecorded'}>
          <header className="ontology-pane-heading">
            <strong>{entry.title}</strong>
            {entry.candidate === undefined
              ? <StatusBadge tone="neutral">上传资料</StatusBadge>
              : <StatusBadge tone={entry.candidate.reviewState === 'approved' ? 'success' : entry.candidate.reviewState === 'rejected' ? 'danger' : 'warning'}>{entry.reviewStateLabel}</StatusBadge>}
          </header>
          <dl className="ontology-terms">
            <div><dt>来源类别</dt><dd data-testid="entry-trust">{entry.trustTierLabel}</dd></div>
            <div><dt>审核状态</dt><dd data-testid="entry-review">{entry.reviewStateLabel}</dd></div>
            <div><dt>解析状态</dt><dd data-testid="entry-parse">{entry.parseStateLabel}</dd></div>
            <div><dt>纳入状态</dt><dd data-testid="entry-admission">{entry.admissionLabel}</dd></div>
          </dl>
          {entry.note === undefined ? null : <p className="ontology-hint">原始出处：{entry.note}</p>}
          {entry.previewRef === undefined
            ? <p className="ontology-hint">尚未归档可读原文；审核不改变这一事实。</p>
            : <Button disabled={busy} onClick={() => { if (entry.previewRef !== undefined) onPreview(entry.previewRef) }}>查看真实原文与片段</Button>}
          {readOnly || entry.candidate === undefined ? null : (
            <>
              <SourceReviewForm entry={entry} busy={busy || reviewBusyId !== undefined}
                onSubmit={(submission) => onReview(entry, submission)} />
              <SourcePromotionForm entry={entry} busy={busy || reviewBusyId !== undefined}
                onSubmit={(submission) => onPromote(entry, submission)} />
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
