import type { ReviewHandoffCandidateView, ReviewHandoffReadResult } from '../api/source-library'
import { TRUST_TIER_LABELS } from '../api/source-library'
import { StatusBadge } from './ui'
import './ontology/ontology.css'

/**
 * The source→asset review hand-off view (design §3/§4/§7). It lists the candidates an agent
 * submitted whose sources are not all confirmed, keeping **each** cited source separate: its own
 * review state, provenance tier, whether it is admitted and the tier's publication standing. The
 * readiness line states plainly whether the candidate still waits on sources, waits on a
 * re-grounding, or is ready for formal asset review.
 *
 * It never presents a source's category, search order or a model probability as "answer credibility";
 * the tier is labelled as the four-level 来源类别 and nothing is collapsed into a single score.
 */
const READINESS_LABELS: Readonly<Record<ReviewHandoffCandidateView['readiness'], string>> = {
  ready_for_review: '全部来源已确认并已重新接地，可进入正式资产审核',
  pending_sources: '仍有来源未确认，候选保持阻断',
  regrounding_required: '全部来源已确认，待重新接地生成新候选版本',
  unknown: '来源状态未知',
}
const REVIEW_LABELS: Readonly<Record<string, string>> = {
  proposed: '待审核',
  approved: '已接受',
  rejected: '已拒绝',
  unknown: '尚未登记为候选来源',
}
const KIND_LABELS: Readonly<Record<ReviewHandoffCandidateView['candidateKind'], string>> = {
  source: '来源候选',
  definition: '定义候选',
  rule: '规则候选',
  action: '动作候选',
}

export function ReviewHandoffList({ handoff, title = '待确认产物（来源→资产衔接）' }: {
  readonly handoff: ReviewHandoffReadResult | undefined
  readonly title?: string
}) {
  if (handoff === undefined) {
    return <section className="ontology-handoff" data-testid="review-handoff" data-availability="loading">
      <h3>{title}</h3>
      <p className="ontology-hint">正在读取来源与资产审核衔接状态…</p>
    </section>
  }
  if (handoff.availability === 'unavailable') {
    return <section className="ontology-handoff" data-testid="review-handoff" data-availability="unavailable">
      <h3>{title}</h3>
      <p className="ontology-hint" data-testid="review-handoff-reason">{handoff.reason}</p>
    </section>
  }
  if (handoff.candidates.length === 0) {
    return <section className="ontology-handoff" data-testid="review-handoff" data-availability="ready" data-count="0">
      <h3>{title}</h3>
      <p className="ontology-hint" data-testid="review-handoff-empty">当前没有引用未确认来源的候选。AI 调研提出的候选会在这里按来源逐条呈现。</p>
    </section>
  }
  return <section className="ontology-handoff" data-testid="review-handoff" data-availability="ready" data-count={handoff.candidates.length}>
    <h3>{title}</h3>
    <p className="ontology-hint">一个候选引用多条来源时，每条来源分别审核；只有全部相关来源审核 + 纳入 + 重新接地后，候选才进入正式资产审核。来源类别、排序与模型概率都不是“答案可信度”。</p>
    <ul className="ontology-handoff__list">
      {handoff.candidates.map((candidate) => <li key={candidate.candidateId} className="ontology-source-card" data-testid="review-handoff-candidate"
        data-kind={candidate.candidateKind} data-blocked={candidate.blocked} data-readiness={candidate.readiness}>
        <header className="ontology-pane-heading">
          <strong>{KIND_LABELS[candidate.candidateKind]}</strong>
          <code>{candidate.candidateId}</code>
          <StatusBadge tone={candidate.blocked ? 'warning' : 'success'}>{candidate.blocked ? '待确认阻断' : '可进入正式审核'}</StatusBadge>
        </header>
        <p className="ontology-hint" data-testid="review-handoff-readiness">{READINESS_LABELS[candidate.readiness]}</p>
        {candidate.regroundedCandidateId === undefined ? null
          : <p className="ontology-hint" data-testid="review-handoff-regrounded">已重新接地为新候选 {candidate.regroundedCandidateId}；旧候选与其阻断信息保留不变。</p>}
        <ul className="ontology-handoff__links">
          {candidate.links.map((link, index) => <li key={`${link.sourceRef.id}:${index}`} data-testid="review-handoff-link"
            data-review={link.reviewState} data-admitted={link.admitted} data-pending={link.pendingConfirmation}>
            <code>{link.sourceRef.id}</code>
            <span data-testid="review-handoff-link-review">{REVIEW_LABELS[link.reviewState] ?? link.reviewState}</span>
            <span data-testid="review-handoff-link-tier">{TRUST_TIER_LABELS[link.trustTier]}</span>
            <span className="ontology-hint">{link.admitted ? '已纳入建模' : '尚未纳入建模'} · {link.groundsPublication ? '该类别可支撑发布' : '该类别暂不可支撑发布'}</span>
            {link.blockReason === undefined ? null : <span className="ontology-hint" data-testid="review-handoff-link-block">阻断：{link.blockReason}</span>}
          </li>)}
        </ul>
        {candidate.blockCodes.length === 0 ? null
          : <p className="ontology-hint" data-testid="review-handoff-codes">待处理：{candidate.blockCodes.join('、')}</p>}
      </li>)}
    </ul>
  </section>
}
