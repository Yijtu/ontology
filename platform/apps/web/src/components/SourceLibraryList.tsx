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
 */
export interface SourceReviewSubmission {
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier: SourceTrustTier
  readonly reason: string
}

export interface SourceLibraryListProps {
  readonly entries: readonly SourceLibraryEntry[]
  readonly readOnly: boolean
  readonly busy: boolean
  readonly reviewBusyId: string | undefined
  readonly onReview: (entry: SourceLibraryEntry, submission: SourceReviewSubmission) => void
  readonly onPreview: (ref: ResourceRef) => void
}

function SourceReviewForm({ entry, busy, onSubmit }: {
  readonly entry: SourceLibraryEntry
  readonly busy: boolean
  readonly onSubmit: (submission: SourceReviewSubmission) => void
}) {
  const candidate = entry.candidate
  const [reviewState, setReviewState] = useState<CandidateSourceReviewState>('approved')
  const [trustTier, setTrustTier] = useState<SourceTrustTier>(candidate?.trustTier ?? 'agent_researched')
  const [reason, setReason] = useState('')
  if (candidate === undefined) return null
  const submit = busy || reason.trim().length === 0
  return (
    <fieldset className="ontology-checks" data-testid={`source-review-${candidate.sourceId}`}>
      <legend>来源审核 · {candidate.sourceId}</legend>
      <p className="ontology-hint">审核通过与提升来源类别是两件事：接受一份网页不会让它自动成为公共标准。请分别说明依据。</p>
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
      <Field label="来源类别（改类别）" hint="只列出契约允许的四级；模型不能代替人工确认。">
        {(attributes) => (
          <select {...attributes} value={trustTier} disabled={busy || reviewState !== 'approved'}
            onChange={(event) => setTrustTier(event.target.value as SourceTrustTier)}>
            {(Object.keys(TRUST_TIER_LABELS) as SourceTrustTier[]).map((tier) => (
              <option key={tier} value={tier}>{TRUST_TIER_LABELS[tier]}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="审核理由" hint="必填；作为追加的审核事件记录，不覆盖历史。">
        {(attributes) => <input {...attributes} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />}
      </Field>
      <Button variant="primary" disabled={submit} data-testid={`source-review-submit-${candidate.sourceId}`}
        onClick={() => onSubmit({ reviewState, trustTier, reason: reason.trim() })}>提交来源审核</Button>
    </fieldset>
  )
}

export function SourceLibraryList({ entries, readOnly, busy, reviewBusyId, onReview, onPreview }: SourceLibraryListProps) {
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
            <SourceReviewForm entry={entry} busy={busy || reviewBusyId !== undefined}
              onSubmit={(submission) => onReview(entry, submission)} />
          )}
        </li>
      ))}
    </ul>
  )
}
