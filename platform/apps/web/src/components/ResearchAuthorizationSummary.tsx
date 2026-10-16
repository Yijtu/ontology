import type { DefinitionCandidateKind, ModelingBriefMustCover, WebSearchFreshnessHint } from '@ontology/contracts'
import type { EffectiveModelSelection } from '../api/model-connections'
import type { ResearchDraftValidation, SearchServiceAvailability } from '../api/research'
import { FRESHNESS_LABELS, RESEARCH_TARGET_KIND_LABELS, RESEARCH_TARGET_KINDS } from '../api/research'
import { EffectiveModelSummary } from './EffectiveModelSummary'
import { Button, Field, StatusBadge } from './ui'

/**
 * The compact task confirmation area shown **before** a run starts (design §2). It is a reusable,
 * presentational component: the owning panel holds the draft state and the start action.
 *
 * It shows the business goal once (carried from the workspace, never re-typed into a research form),
 * the questions that must be covered, the retrieval window, the **actual** model and search service
 * that will receive the request and the outbound content, and the enforceable limits. Only the
 * public brief is sent — no project record, private original, history answer or credential. Domains,
 * candidate kinds and quotas live in the collapsed "范围与限制" area because they are scoped
 * constraints, not the task itself. When the deployment allows no domain, the area points the user
 * at an administrator instead of letting the model widen the allowlist itself.
 */
export interface ResearchAuthorizationSummaryProps {
  readonly goal: string
  readonly mustCover: readonly ModelingBriefMustCover[]
  readonly domains: readonly string[]
  readonly domainsText: string
  readonly targetKinds: readonly DefinitionCandidateKind[]
  readonly freshnessHint: WebSearchFreshnessHint
  readonly sourceLimit: string
  readonly candidateLimit: string
  readonly timeLimitMinutes: string
  readonly model: EffectiveModelSelection | undefined
  readonly modelPhase: 'loading' | 'ready' | 'unresolvable'
  /** The resolved search service, or `undefined` while it is still being read. */
  readonly searchService: SearchServiceAvailability | undefined
  readonly validation: ResearchDraftValidation
  readonly busy: boolean
  readonly readOnly: boolean
  readonly blockedReasons: readonly string[]
  readonly canStart: boolean
  readonly onGoalChange: (goal: string) => void
  readonly onDomainsChange: (text: string) => void
  readonly onToggleKind: (kind: DefinitionCandidateKind) => void
  readonly onFreshnessChange: (hint: WebSearchFreshnessHint) => void
  readonly onLimitChange: (field: 'source' | 'candidate' | 'time', value: string) => void
  readonly onStart: () => void
  readonly onReset: () => void
  readonly onConfigureModel?: () => void
  readonly onConfigureSearch?: () => void
  /** `continuation` re-confirms scope for a new run grounded in a previous one, rather than a fresh one. */
  readonly mode?: 'new' | 'continuation'
  /** The previous run a continuation is linked to, shown so the link is explicit. */
  readonly continuationOfRun?: string
  /** Abandons a pending continuation and returns to the previous run's progress view. */
  readonly onCancelContinuation?: () => void
}

function SearchServiceLine({ service, onConfigure }: { readonly service: SearchServiceAvailability | undefined; readonly onConfigure?: () => void }) {
  if (service === undefined) return <p className="research-hint" data-testid="research-search-loading">正在解析实际使用的公共搜索服务。</p>
  if (service.state === 'available') {
    const summary = service.selection.connectionSummary
    return <p data-testid="research-search-service" data-state="available">
      {summary === undefined ? '已授权的公共搜索服务' : `${summary.name}（配置版本 ${summary.revision}）`}
    </p>
  }
  return <p className="research-hint" data-testid="research-search-service" data-state={service.state}>
    {service.reason}
    {onConfigure === undefined ? null : <Button variant="quiet" onClick={onConfigure}>前往 AI 设置</Button>}
  </p>
}

export function ResearchAuthorizationSummary(props: ResearchAuthorizationSummaryProps) {
  const {
    goal, mustCover, domains, domainsText, targetKinds, freshnessHint, sourceLimit, candidateLimit, timeLimitMinutes,
    model, modelPhase, searchService, validation, busy, readOnly, blockedReasons, canStart,
    onGoalChange, onDomainsChange, onToggleKind, onFreshnessChange, onLimitChange, onStart, onReset,
    onConfigureModel, onConfigureSearch, mode = 'new', continuationOfRun, onCancelContinuation,
  } = props
  const domainText = domains.length === 0 ? '（尚未填写允许域名）' : domains.join('、')
  const limits = `${Number.isSafeInteger(Number(sourceLimit)) ? sourceLimit : '—'} 份来源 / ${Number.isSafeInteger(Number(candidateLimit)) ? candidateLimit : '—'} 个候选 / ${Number.isSafeInteger(Number(timeLimitMinutes)) ? timeLimitMinutes : '—'} 分钟`
  return <section className="research-confirm" data-testid="research-confirm" data-mode={mode} aria-label="任务确认">
    <header className="research-confirm__head"><div><p className="ui-eyebrow">建模助手任务</p>
      <h3>{mode === 'continuation' ? '基于已有结果追加调研' : '开始前确认这一次调研'}</h3>
      <p className="research-hint">目标来自工作区；agent 可以提出范围建议，但不能自行授权扩大范围或额度。</p>
      {mode === 'continuation' && continuationOfRun !== undefined ? <p className="research-hint" data-testid="research-continuation-of">
        这是一次新的授权，关联前一次执行 <code>{continuationOfRun}</code> 的产物；不会复活或重试原执行，前一次的候选会保留。
        {onCancelContinuation === undefined ? null : <Button variant="quiet" onClick={onCancelContinuation}>返回查看上一次</Button>}
      </p> : null}</div>
      <StatusBadge tone={mode === 'continuation' ? 'warning' : 'neutral'}>{mode === 'continuation' ? '追加调研' : '公共研究'}</StatusBadge></header>

    <Field label="业务目标" hint="默认沿用工作区目标，可在此微调；不会要求重填研究表单。">
      {(attributes) => <textarea {...attributes} data-testid="research-goal" rows={2} value={goal} disabled={busy} onChange={(event) => onGoalChange(event.target.value)} />}
    </Field>

    {mustCover.length === 0 ? <p className="research-hint" data-testid="research-must-cover-empty">未单独指定“必须覆盖的问题”；开始后按目标整段推进。</p>
      : <section data-testid="research-must-cover" aria-label="必须覆盖的问题">
        <h4>必须覆盖的问题</h4>
        <ul>{mustCover.map((entry, index) => <li key={`${entry.kind}:${entry.name}:${index}`} data-testid="research-must-cover-item">{entry.name}</li>)}</ul>
      </section>}

    <section className="research-receiver" aria-label="实际接收方">
      <h4>实际使用的服务与外发内容</h4>
      <dl className="research-receiver__dl">
        <div><dt>研究模型</dt><dd>
          {modelPhase === 'loading' ? <span data-testid="research-model-loading">正在解析…</span>
            : modelPhase === 'unresolvable' ? <span data-testid="research-model-unresolvable">无法解析；开始时由服务端固定实际接收方。
              {onConfigureModel === undefined ? null : <Button variant="quiet" onClick={onConfigureModel}>前往 AI 设置</Button>}</span>
              : model === undefined ? <span data-testid="research-model-missing">当前工作区没有解析到研究模型。</span>
                : <EffectiveModelSummary selection={model} variant="compact" {...(onConfigureModel === undefined ? {} : { onConfigure: onConfigureModel })} />}
        </dd></div>
        <div><dt>公共搜索服务</dt><dd><SearchServiceLine service={searchService} {...(onConfigureSearch === undefined ? {} : { onConfigure: onConfigureSearch })} /></dd></div>
        <div><dt>时间版本要求</dt><dd data-testid="research-freshness-summary">{FRESHNESS_LABELS[freshnessHint]}</dd></div>
        <div><dt>外发内容</dt><dd data-testid="research-outbound">仅这份公共研究 brief：目标、检索域（{domainText}）、候选类型与时间范围。项目记录、私有原文、历史问答与密钥不随研究外发。</dd></div>
        <div><dt>可执行额度</dt><dd data-testid="research-limits-summary">{limits}；调用次数与 token 以部署策略上限为准，用户只能收紧。</dd></div>
      </dl>
    </section>

    <p className="research-notice" data-testid="research-candidate-notice" role="note">
      研究只产出来源候选，需人工确认来源类别后才可纳入建模；接受一份来源不会把它提升为公共标准。
    </p>

    {blockedReasons.length === 0 ? null : <ul className="research-blockers" data-testid="research-blockers">
      {blockedReasons.map((reason, index) => <li key={index}>{reason}</li>)}
    </ul>}
    {!validation.valid ? <p className="research-hint" data-testid="research-validation" data-valid="false">{validation.reason}</p> : null}

    <details className="research-scope-limits" data-testid="research-scope-limits">
      <summary>范围与限制</summary>
      <Field label="允许检索的域名" hint="逗号或换行分隔，例如 example.com、standard.example.org；最多 32 个。此输入不构成授权，模型不能扩大名单。">
        {(attributes) => <textarea {...attributes} data-testid="research-domains" rows={2} value={domainsText} disabled={busy} onChange={(event) => onDomainsChange(event.target.value)} />}
      </Field>
      <fieldset className="research-kinds" data-testid="research-target-kinds">
        <legend>希望生成的候选类型</legend>
        {RESEARCH_TARGET_KINDS.map((kind) => <label key={kind}>
          <input type="checkbox" data-testid={`research-target-${kind}`} checked={targetKinds.includes(kind)} disabled={busy} onChange={() => onToggleKind(kind)} />
          <span>{RESEARCH_TARGET_KIND_LABELS[kind]}</span>
        </label>)}
      </fieldset>
      <div className="research-limits">
        <Field label="时间范围">
          {(attributes) => <select {...attributes} data-testid="research-freshness" value={freshnessHint} disabled={busy} onChange={(event) => onFreshnessChange(event.target.value as WebSearchFreshnessHint)}>
            {(Object.keys(FRESHNESS_LABELS) as readonly WebSearchFreshnessHint[]).map((hint) => <option key={hint} value={hint}>{FRESHNESS_LABELS[hint]}</option>)}
          </select>}
        </Field>
        <Field label="来源数上限" hint="1..200">
          {(attributes) => <input {...attributes} data-testid="research-source-limit" inputMode="numeric" value={sourceLimit} disabled={busy} onChange={(event) => onLimitChange('source', event.target.value)} />}
        </Field>
        <Field label="候选数上限" hint="1..500">
          {(attributes) => <input {...attributes} data-testid="research-candidate-limit" inputMode="numeric" value={candidateLimit} disabled={busy} onChange={(event) => onLimitChange('candidate', event.target.value)} />}
        </Field>
        <Field label="时限（分钟）" hint="1..120">
          {(attributes) => <input {...attributes} data-testid="research-time-limit" inputMode="numeric" value={timeLimitMinutes} disabled={busy} onChange={(event) => onLimitChange('time', event.target.value)} />}
        </Field>
      </div>
    </details>

    <div className="research-actions">
      <Button variant="primary" data-testid="research-start" disabled={!canStart} onClick={onStart}>
        {busy ? '正在创建调研任务…' : mode === 'continuation' ? '基于已有结果追加调研' : '开始调研并提出候选'}
      </Button>
      <Button variant="quiet" onClick={onReset} disabled={busy} data-testid="research-reset">重置输入</Button>
    </div>
    {readOnly ? <p className="research-hint" data-testid="research-readonly">只读角色可以查看授权范围与进度，但不能发起研究。</p> : null}
  </section>
}
