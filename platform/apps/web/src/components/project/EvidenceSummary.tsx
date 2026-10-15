import type { ProvenanceEvidenceView, ResourceRef } from '@ontology/contracts'
import type { AnswerSourceView } from '../../api/source-views'
import { formatLocator } from './VerifiedCell'

/**
 * The source axes describe the *kind* of source, how exactly it is located and whether the original
 * is still readable. They are never a ranking, a retrieval score or a model probability, and the
 * evidence view carries no trust-tier category, so that axis is disclosed as a server gap rather
 * than inferred from the source family or readability.
 */
const SOURCE_FAMILY_LABELS: Readonly<Record<AnswerSourceView['family'], string>> = {
  document_span: '文档原文片段',
  structured_qa: '结构化问答来源',
  rule_support: '规则支撑证据',
  data_query: '查询/计算结果来源',
}
const DATA_MODE_LABELS: Readonly<Record<string, string>> = {
  synthetic: '合成数据',
  observed: '观测数据',
  forecast: '预测数据',
  simulation: '仿真数据',
  live: '实机数据',
}

/** The current availability of the source read: an invalidation notice, never an answer confidence. */
export function sourceReadabilityNotice(readability: AnswerSourceView['readability']): string {
  switch (readability) {
    case 're_readable':
      return '按所选答案的固定版本可重读原始来源。'
    case 'archived_snapshot_only':
      return '仅保留核验时归档的固定快照；不能证明原始来源当前仍有效，也不能据此认定答案可信度。'
    case 'unverifiable':
      return '原始来源当前无法核验；该来源已失效，不能作为当前有效依据。'
  }
}

function SourceAxis({ source }: { readonly source: AnswerSourceView }) {
  const approximate =
    source.precision === 'approximate' ||
    source.fragments?.some((fragment) => fragment.precision === 'approximate') === true
  return (
    <div className="project-support-group" data-testid="evidence-source-axis">
      <h4>来源类别</h4>
      <p data-testid="evidence-source-category">
        服务端未提供四级来源类别（如已确认公共标准／业务权威资料）；前端不据来源类型、检索排序或模型概率推断类别，
        也不将其显示为「答案可信度」。
      </p>
      <h4>来源类型与当前状态</h4>
      <p data-testid="evidence-source-family" data-family={source.family}>
        {SOURCE_FAMILY_LABELS[source.family]} ·{' '}
        <span
          className={`project-state project-state--${approximate ? 'partial' : 'ready'}`}
          data-testid="evidence-source-precision"
        >
          {approximate ? '近似定位' : '精确定位'}
        </span>{' '}
        · {DATA_MODE_LABELS[source.dataMode] ?? source.dataMode}
      </p>
      <p
        className="project-source-note"
        data-testid="evidence-source-readability"
        data-readability={source.readability}
      >
        当前失效提示：{sourceReadabilityNotice(source.readability)}
      </p>
      {source.sourceReadLimitation === undefined ? null : (
        <p className="project-source-note" data-testid="evidence-source-limitation">
          {source.sourceReadLimitation}
        </p>
      )}
      {source.originalRef === undefined && source.parseRef === undefined ? null : (
        <details className="project-audit" data-testid="evidence-source-reviewed-version">
          <summary>审核时固定版本</summary>
          {source.originalRef === undefined ? null : (
            <>
              <p>
                原始文件：
                <code>
                  {source.originalRef.id}@{source.originalRef.version}
                </code>
              </p>
              <p>
                <code>{source.originalRef.digest}</code>
              </p>
            </>
          )}
          {source.parseRef === undefined ? null : (
            <>
              <p>
                解析版本：
                <code>
                  {source.parseRef.id}@{source.parseRef.version}
                </code>
              </p>
              <p>
                <code>{source.parseRef.digest}</code>
              </p>
            </>
          )}
          {source.locator === undefined ? null : (
            <p data-testid="evidence-source-locator">原文定位：{formatLocator(source.locator)}</p>
          )}
        </details>
      )}
    </div>
  )
}

/** Fact premises and reviewed policy text are independent evidence axes. */
export function EvidenceSummary({
  evidence,
  source,
  onOpenEvidence,
}: {
  readonly evidence: ProvenanceEvidenceView
  readonly source?: AnswerSourceView
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
      {source === undefined ? (
        <div className="project-support-group" data-testid="evidence-source-axis">
          <h4>来源类别</h4>
          <p data-testid="evidence-source-category">
            服务端未提供四级来源类别（如已确认公共标准／业务权威资料）；前端不据来源类型、检索排序或模型概率推断类别，
            也不将其显示为「答案可信度」。
          </p>
        </div>
      ) : (
        <SourceAxis source={source} />
      )}
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
        {evidence.specification?.spans.map((view, index) => {
          const span = view.span
          const ready = span.kind === 'structured' || span.precision === 'exact'
          const label = span.kind === 'structured' ? '表格定位' : span.precision === 'exact' ? '精确定位' : '近似定位'
          const key = span.kind === 'structured' ? span.recordId : span.chunkId
          return (
            <div key={`${span.parseId}:${key}:${index}`}>
              <p>
                <span className={`project-state project-state--${ready ? 'ready' : 'partial'}`}>
                  {label}
                </span>{' '}
                {formatLocator(span.locator)}
              </p>
              {onOpenEvidence === undefined ? null : (
                <button
                  className="project-source-button"
                  type="button"
                  onClick={() => onOpenEvidence(view.evidenceRef)}
                >
                  查看这段原文 ↗
                </button>
              )}
              <details className="project-audit">
                <summary>文件与解析版本</summary>
                <p>
                  <code>
                    {view.documentRef.id}@{view.documentRef.version}
                  </code>
                </p>
                <p>
                  <code>{view.documentRef.digest}</code>
                </p>
                <p data-testid="evidence-policy-document-version">
                  审核时文档版本：
                  <code>
                    {view.documentVersionRef.id}@{view.documentVersionRef.version}
                  </code>
                </p>
                <p data-testid="evidence-policy-parser-version">解析器版本：{view.parserVersion}</p>
              </details>
            </div>
          )
        })}
      </div>
      <p className="project-source-note">
        事实支撑完整性与规则原文定位分别核验。规则的条件成立或适用性结论，不代表额外的业务行动要求。
        来源类别、检索排序与模型概率都只描述来源本身，不是「答案可信度」，也不随本摘要提升或降低结论。
      </p>
    </div>
  )
}
