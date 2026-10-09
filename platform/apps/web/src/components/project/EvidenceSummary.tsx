import type { ProvenanceEvidenceView, ResourceRef } from '@ontology/contracts'
import { formatLocator } from './VerifiedCell'

/** Fact premises and reviewed policy text are independent evidence axes. */
export function EvidenceSummary({
  evidence,
  onOpenEvidence,
}: {
  readonly evidence: ProvenanceEvidenceView
  readonly onOpenEvidence?: (ref: ResourceRef) => void
}) {
  return (
    <div className="project-evidence-summary">
      <div className="project-result-status">
        <span
          className={`project-state project-state--${evidence.outcome === 'verifiable' ? 'ready' : 'conflict'}`}
        >
          {evidence.outcome === 'verifiable' ? '归档证据已核验' : '证据无法核验'}
        </span>
        {evidence.asOf === undefined && evidence.validAt === undefined ? null : (
          <span className="project-state">固定证据时点</span>
        )}
      </div>
      {evidence.asOf === undefined ? null : <p className="project-source-note">记录时点：{evidence.asOf}</p>}
      {evidence.validAt === undefined ? null : (
        <p className="project-source-note">业务有效时点：{evidence.validAt}</p>
      )}
      <div className="project-support-group" data-testid="evidence-fact-axis">
        <h4>事实前提</h4>
        <p>
          {evidence.factSupport === undefined
            ? '服务端未报告事实前提覆盖情况。'
            : evidence.factSupport.complete
              ? '事实前提支撑完整。'
              : '事实前提支撑不完整。'}
        </p>
        {evidence.factSupport?.reason === undefined ? null : <p>{evidence.factSupport.reason}</p>}
        {evidence.premiseGroups.length === 0 ? (
          <p>未列出规则前提组。</p>
        ) : (
          <ol>
            {evidence.premiseGroups.map((group, index) => (
              <li key={group.groupId}>
                前提 {index + 1} · {group.alternativeEvidenceIds.length} 条实际支撑
                {group.alternativeEvidenceIds.length > 1 ? '，任一条有效支撑可满足此组' : ''}
                <details className="project-audit">
                  <summary>支撑标识</summary>
                  {group.alternativeEvidenceIds.map((id) => (
                    <p key={id}>
                      <code>{id}</code>
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="project-support-group" data-testid="evidence-policy-axis">
        <h4>规则原文</h4>
        <p>
          {evidence.specification === undefined
            ? '服务端未报告规则原文定位。'
            : evidence.specification.coverage.complete
              ? '已定位审核时采用的规则原文。'
              : '规则原文定位不完整。'}
        </p>
        {evidence.specification?.coverage.reason === undefined ? null : (
          <p>{evidence.specification.coverage.reason}</p>
        )}
        {evidence.specification?.spans.map((span, index) => (
          <div key={`${span.parseId}:${span.chunkId}:${index}`}>
            <p>
              <span
                className={`project-state project-state--${span.precision === 'exact' ? 'ready' : 'partial'}`}
              >
                {span.precision === 'exact' ? '精确定位' : '近似定位'}
              </span>{' '}
              {formatLocator(span.locator)}
            </p>
            {onOpenEvidence === undefined ? null : (
              <button
                className="project-source-button"
                type="button"
                onClick={() => onOpenEvidence(span.evidenceRef)}
              >
                查看这段原文 ↗
              </button>
            )}
            <details className="project-audit">
              <summary>文件与解析版本</summary>
              <p>
                <code>
                  {span.documentRef.id}@{span.documentRef.version}
                </code>
              </p>
              <p>
                <code>{span.documentRef.digest}</code>
              </p>
            </details>
          </div>
        ))}
      </div>
      <p className="project-source-note">
        事实支撑完整性与规则原文定位分别核验。规则的条件成立或适用性结论，不代表额外的业务行动要求。
      </p>
    </div>
  )
}
