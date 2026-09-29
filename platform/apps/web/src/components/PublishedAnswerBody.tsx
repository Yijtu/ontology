import type { ReactNode } from 'react'
import type {
  DraftClaim,
  PublishedAnswer,
  ResourceRef,
  VerifiedAssertion,
  VersionRef,
} from '@ontology/contracts'

export type PublishedAnswerLabelKind = 'subject' | 'predicate'

export interface PublishedAnswerBodyProps {
  readonly answer: PublishedAnswer
  /** Deployment-owned semantic labels. Missing labels fall back to the stable ID. */
  readonly resolveLabel?: (id: string, kind: PublishedAnswerLabelKind) => string | undefined
  /** The host decides how an already-authorized source reference opens in its UI. */
  readonly onEvidenceReference?: (ref: ResourceRef) => void
}

interface AnswerBodyShape {
  readonly schemaVersion: 'answer-draft@1' | 'answer-draft@2'
  readonly blocks: readonly unknown[]
  readonly claims: readonly unknown[]
  readonly assertions: readonly unknown[]
}

interface ClaimBlock {
  readonly kind: 'claim'
  readonly claimId: string
}

interface AssertionBlock {
  readonly kind: 'assertion'
  readonly assertionId: string
}

interface LegacySummaryBlock {
  readonly kind: 'summary'
  readonly evidenceCount: number
}

type AnswerBlock = ClaimBlock | AssertionBlock | LegacySummaryBlock

type DisplayStatement =
  | { readonly kind: 'claim'; readonly key: string; readonly claim: DraftClaim; readonly evidenceRefs: readonly ResourceRef[] }
  | { readonly kind: 'assertion'; readonly key: string; readonly assertion: VerifiedAssertion; readonly evidenceRefs: readonly ResourceRef[] }

interface ContentView {
  readonly statements: readonly DisplayStatement[]
  readonly legacyEvidenceCount?: number
  readonly hasOmittedContent: boolean
  readonly hasDisplayableContent: boolean
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RESOURCE_KINDS = new Set([
  'profile', 'run', 'evidence', 'draft', 'verification', 'answer', 'artifact', 'document',
  'chunk', 'plan', 'simulation', 'computation', 'dataset', 'checkpoint', 'tool_result', 'job', 'source',
])
const CLAIM_KINDS = new Set(['observation', 'prediction', 'computation', 'rule_derivation'])
const RULE_JUDGEMENTS = new Set(['true', 'false', 'unknown', 'conflict'])
const LIMITATION_LABELS: Readonly<Record<string, string>> = {
  'limited_factual_result': '有限事实回答：只显示已经通过核验的陈述。',
  'incomplete-evidence': '证据不完整，答案只反映已核验的部分。',
  'no_supported_statements': '没有可展示的已通过核验陈述。',
  'verification_never_passed': '没有可用的已通过核验结果。',
  'unclassified_evidence_gap': '存在尚未分类的证据缺口。',
  'draft_hash_mismatch': '正文与核验时的版本不一致。',
  'evidence_manifest_mismatch': '证据清单与核验时的版本不一致。',
  'missing_claims': '缺少可核验的结构化陈述。',
  'claim_limit_exceeded': '待核验陈述超过了安全处理上限。',
  'unbound_claim': '有陈述没有绑定到证据。',
  'evidence_not_found': '有陈述引用的证据不可用。',
  'result_digest_mismatch': '引用结果的完整性校验未通过。',
  'result_unreadable': '有证据当前不可读取。',
  'number_mismatch': '数值与证据不一致。',
  'unit_mismatch': '单位与证据不一致。',
  'subject_mismatch': '对象与证据不一致。',
  'predicate_mismatch': '属性与证据不一致。',
  'time_mismatch': '时间与证据不一致。',
  'source_not_yet_valid': '证据在指定时点尚未生效。',
  'stale_source': '证据已过期；结果只能作为历史信息查看。',
  'semantic_unsupported': '陈述缺少足够的语义支持。',
  'semantic_insufficient': '现有证据不足以支持陈述。',
  'semantic_unavailable': '语义核验不可用。',
  'evidence_reference_mismatch': '证据引用与归档记录不一致。',
  'visible_statement_unbound': '有正文内容没有绑定到已核验的陈述。',
  'assertion_mismatch': '结构化陈述与证据不一致。',
  'document_quote_mismatch': '引文与归档原文不一致。',
  'unverified_limitation': '限制说明没有通过核验。',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function isResourceRef(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    nonEmptyString(value['id']) &&
    nonEmptyString(value['version']) &&
    isDigest(value['digest']) &&
    typeof value['kind'] === 'string' &&
    RESOURCE_KINDS.has(value['kind'])
  )
}

function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && nonEmptyString(value['id']) && nonEmptyString(value['version']) && isDigest(value['digest'])
}

function isEvidenceBindings(value: unknown): value is readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((binding: unknown) =>
    isRecord(binding) &&
    isResourceRef(binding['evidenceRef']) &&
    isDigest(binding['resultDigest']) &&
    nonEmptyString(binding['valuePointer']) &&
    nonEmptyString(binding['subjectPointer']),
  )
}

function isDraftClaim(value: unknown): value is DraftClaim {
  if (!isRecord(value) || !isUuid(value['claimId']) || !nonEmptyString(value['subject']) || !nonEmptyString(value['predicate'])) {
    return false
  }
  if (!isRecord(value['value']) || typeof value['value']['unit'] !== 'string') return false
  const quantity = value['value']['value']
  if (typeof quantity !== 'string' && (typeof quantity !== 'number' || !Number.isFinite(quantity))) return false
  if (!isRecord(value['time'])) return false
  for (const key of ['asOf', 'validFrom', 'validTo']) {
    if (value['time'][key] !== undefined && typeof value['time'][key] !== 'string') return false
  }
  return typeof value['kind'] === 'string' && CLAIM_KINDS.has(value['kind']) && isEvidenceBindings(value['references'])
}

function isLocator(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value['kind'] === 'page') {
    const page = value['page']
    return typeof page === 'number' && Number.isSafeInteger(page) && page >= 1
  }
  if (value['kind'] === 'offset') {
    const start = value['startOffset']
    const end = value['endOffset']
    return typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 &&
      typeof end === 'number' && Number.isSafeInteger(end) && end >= start
  }
  if (value['kind'] === 'approximate_locator') {
    return value['normalizationMapRef'] === undefined || typeof value['normalizationMapRef'] === 'string'
  }
  return false
}

function isVerifiedAssertion(value: unknown): value is VerifiedAssertion {
  if (
    !isRecord(value) ||
    !isUuid(value['assertionId']) ||
    !nonEmptyString(value['subject']) ||
    !nonEmptyString(value['predicate']) ||
    !isEvidenceBindings(value['references'])
  ) return false
  switch (value['kind']) {
    case 'string':
    case 'enum':
      return typeof value['value'] === 'string'
    case 'boolean':
      return typeof value['value'] === 'boolean'
    case 'entity_ref':
      return isResourceRef(value['value']) && (value['displayName'] === undefined || typeof value['displayName'] === 'string')
    case 'relation_ref':
      return isRecord(value['value']) && nonEmptyString(value['value']['type']) &&
        isResourceRef(value['value']['from']) && isResourceRef(value['value']['to'])
    case 'rule_judgement':
      return typeof value['value'] === 'string' && RULE_JUDGEMENTS.has(value['value']) &&
        isVersionRef(value['ruleRef']) && Array.isArray(value['premiseRefs']) &&
        value['premiseRefs'].length > 0 && value['premiseRefs'].every(isResourceRef)
    case 'document_quote':
      return typeof value['quote'] === 'string' && isResourceRef(value['documentRef']) &&
        isLocator(value['locator']) && isDigest(value['quoteDigest']) && isDigest(value['textDigest']) &&
        (value['precision'] === 'exact' || value['precision'] === 'approximate')
    case 'artifact_summary':
      return isResourceRef(value['artifactRef']) && typeof value['summary'] === 'string'
    default:
      return false
  }
}

function bodyShape(value: unknown): AnswerBodyShape | undefined {
  if (!isRecord(value)) return undefined
  if (
    (value['schemaVersion'] !== 'answer-draft@1' && value['schemaVersion'] !== 'answer-draft@2') ||
    !Array.isArray(value['blocks']) ||
    !Array.isArray(value['claims']) ||
    !Array.isArray(value['assertions'])
  ) return undefined
  return {
    schemaVersion: value['schemaVersion'],
    blocks: value['blocks'],
    claims: value['claims'],
    assertions: value['assertions'],
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000')
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function answerBlock(value: unknown, schemaVersion: AnswerBodyShape['schemaVersion']): AnswerBlock | undefined {
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'claim' && typeof value['claimId'] === 'string' && exactKeys(value, ['kind', 'claimId'])) {
    return { kind: 'claim', claimId: value['claimId'] }
  }
  if (
    schemaVersion === 'answer-draft@2' &&
    value['kind'] === 'assertion' &&
    typeof value['assertionId'] === 'string' &&
    exactKeys(value, ['kind', 'assertionId'])
  ) return { kind: 'assertion', assertionId: value['assertionId'] }
  if (
    schemaVersion === 'answer-draft@1' &&
    value['kind'] === 'summary' &&
    isNonnegativeSafeInteger(value['evidenceCount']) &&
    exactKeys(value, ['kind', 'question', 'evidenceCount', 'deficits', 'limitations']) &&
    typeof value['question'] === 'string' &&
    stringArray(value['deficits']) !== undefined &&
    stringArray(value['limitations']) !== undefined
  ) return { kind: 'summary', evidenceCount: value['evidenceCount'] }
  return undefined
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) return undefined
  return value
}

function evidenceRefsFromClaim(claim: DraftClaim): readonly ResourceRef[] {
  return uniqueRefs(claim.references.map((binding) => binding.evidenceRef))
}

function evidenceRefsFromAssertion(assertion: VerifiedAssertion): readonly ResourceRef[] {
  const refs = assertion.references.map((binding) => binding.evidenceRef)
  if (assertion.kind === 'rule_judgement') refs.push(...assertion.premiseRefs)
  if (assertion.kind === 'document_quote') refs.push(assertion.documentRef)
  if (assertion.kind === 'artifact_summary') refs.push(assertion.artifactRef)
  return uniqueRefs(refs)
}

function uniqueRefs(refs: readonly ResourceRef[]): readonly ResourceRef[] {
  const unique = new Map<string, ResourceRef>()
  for (const ref of refs) unique.set(`${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`, ref)
  return [...unique.values()]
}

function indexUnique<T>(
  values: readonly unknown[],
  isValid: (value: unknown) => value is T,
  idOf: (value: T) => string,
): { readonly values: ReadonlyMap<string, T>; readonly invalid: boolean } {
  const indexed = new Map<string, T>()
  const duplicates = new Set<string>()
  let invalid = false
  for (const value of values) {
    if (!isValid(value)) {
      invalid = true
      continue
    }
    const id = idOf(value)
    if (indexed.has(id)) {
      indexed.delete(id)
      duplicates.add(id)
      invalid = true
      continue
    }
    if (!duplicates.has(id)) indexed.set(id, value)
  }
  return { values: indexed, invalid }
}

function collectContent(body: AnswerBodyShape): ContentView {
  const claims = indexUnique(body.claims, isDraftClaim, (claim) => claim.claimId)
  const assertions = indexUnique(body.assertions, isVerifiedAssertion, (assertion) => assertion.assertionId)
  const statements: DisplayStatement[] = []
  const referencedClaimIds = new Set<string>()
  const referencedAssertionIds = new Set<string>()
  let legacyEvidenceCount: number | undefined
  let omitted = claims.invalid || assertions.invalid

  for (const rawBlock of body.blocks) {
    const block = answerBlock(rawBlock, body.schemaVersion)
    if (block === undefined) {
      omitted = true
      continue
    }
    if (block.kind === 'summary') {
      legacyEvidenceCount = block.evidenceCount
      continue
    }
    if (block.kind === 'claim') {
      referencedClaimIds.add(block.claimId)
      const claim = claims.values.get(block.claimId)
      if (claim === undefined) {
        omitted = true
        continue
      }
      statements.push({ kind: 'claim', key: `claim:${claim.claimId}`, claim, evidenceRefs: evidenceRefsFromClaim(claim) })
      continue
    }
    referencedAssertionIds.add(block.assertionId)
    const assertion = assertions.values.get(block.assertionId)
    if (assertion === undefined) {
      omitted = true
      continue
    }
    if (assertion.kind === 'artifact_summary') {
      // Do not reproduce free-form summaries in this generic business answer surface.
      omitted = true
      continue
    }
    statements.push({ kind: 'assertion', key: `assertion:${assertion.assertionId}`, assertion, evidenceRefs: evidenceRefsFromAssertion(assertion) })
  }

  if ([...claims.values.keys()].some((id) => !referencedClaimIds.has(id))) omitted = true
  if ([...assertions.values.keys()].some((id) => !referencedAssertionIds.has(id))) omitted = true
  if (body.schemaVersion === 'answer-draft@1' && assertions.values.size > 0) omitted = true
  return {
    statements,
    ...(legacyEvidenceCount === undefined ? {} : { legacyEvidenceCount }),
    hasOmittedContent: omitted,
    hasDisplayableContent: statements.length > 0 || legacyEvidenceCount !== undefined,
  }
}

function readableLabel(
  id: string,
  kind: PublishedAnswerLabelKind,
  resolver: PublishedAnswerBodyProps['resolveLabel'],
): string {
  try {
    const label = resolver?.(id, kind)
    if (typeof label === 'string' && label.trim().length > 0) return label
  } catch {
    // Deployment metadata is optional; stable IDs remain a readable fallback.
  }
  return id
}

function quantityText(value: number | string): string {
  return typeof value === 'string' ? value : String(value)
}

function limitationText(code: string): { readonly message: string; readonly code?: string } {
  if (code.startsWith('missing_evidence:')) {
    return { message: '缺少支持答案的证据。' }
  }
  const known = LIMITATION_LABELS[code]
  if (known !== undefined) return { message: known }
  const visibleCode = code.length > 100 ? `${code.slice(0, 100)}…` : code
  return {
    message: '存在未识别的限制；这不是业务结论，答案需谨慎使用。',
    code: visibleCode,
  }
}

function renderLimitations(value: unknown): ReactNode {
  if (!Array.isArray(value)) {
    return <p data-testid="published-answer-limitations-invalid">限制信息无法读取；请勿将此答案视为无条件结论。</p>
  }
  const codes = value.filter((entry: unknown): entry is string => typeof entry === 'string')
  const invalidEntries = codes.length !== value.length
  if (codes.length === 0 && !invalidEntries) return null
  return (
    <section aria-label="答案限制" data-testid="published-answer-limitations">
      <h3>限制与缺口</h3>
      {invalidEntries ? <p>有无法读取的限制项；答案可能不完整。</p> : null}
      <ul>
        {codes.map((code, index) => {
          const description = limitationText(code)
          return (
            <li key={`${index}:${code}`} data-testid="published-answer-limitation">
              {description.message}
              {description.code === undefined ? null : <> <code>{description.code}</code></>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function renderTimeBinding(time: DraftClaim['time']): ReactNode {
  const values: { readonly label: string; readonly value: string }[] = []
  if (typeof time.asOf === 'string') values.push({ label: '截至', value: time.asOf })
  if (typeof time.validFrom === 'string') values.push({ label: '有效自', value: time.validFrom })
  if (typeof time.validTo === 'string') values.push({ label: '有效至', value: time.validTo })
  if (values.length === 0) return null
  return (
    <p data-testid="published-answer-claim-time">
      {values.map((entry, index) => (
        <span key={`${entry.label}:${entry.value}`}>
          {index === 0 ? null : ' · '}{entry.label} <time dateTime={entry.value}>{entry.value}</time>
        </span>
      ))}
    </p>
  )
}

function evidenceLabel(ref: ResourceRef, index: number, onEvidenceReference: PublishedAnswerBodyProps['onEvidenceReference']): ReactNode {
  const label = `来源 ${index + 1}`
  if (onEvidenceReference === undefined) return <span>{label}</span>
  return (
    <button
      type="button"
      aria-label={`打开${label}`}
      data-testid="published-answer-evidence-reference"
      onClick={() => onEvidenceReference(ref)}
    >
      {label}
    </button>
  )
}

function EvidenceReferences({
  refs,
  onEvidenceReference,
}: {
  readonly refs: readonly ResourceRef[]
  readonly onEvidenceReference: PublishedAnswerBodyProps['onEvidenceReference']
}): ReactNode {
  if (refs.length === 0) return null
  return (
    <p data-testid="published-answer-evidence-references">
      {refs.map((ref, index) => (
        <span key={`${ref.kind}:${ref.id}:${ref.version}`}>
          {index === 0 ? null : ' · '}{evidenceLabel(ref, index, onEvidenceReference)}
        </span>
      ))}
    </p>
  )
}

function ClaimView({
  claim,
  evidenceRefs,
  resolveLabel,
  onEvidenceReference,
}: {
  readonly claim: DraftClaim
  readonly evidenceRefs: readonly ResourceRef[]
  readonly resolveLabel: PublishedAnswerBodyProps['resolveLabel']
  readonly onEvidenceReference: PublishedAnswerBodyProps['onEvidenceReference']
}): ReactNode {
  const kind = claim.kind === 'observation' ? '观测' : claim.kind === 'prediction' ? '预测' : claim.kind === 'computation' ? '计算' : '规则推导'
  return (
    <article data-testid="published-answer-statement" data-kind="claim">
      <h4>{readableLabel(claim.subject, 'subject', resolveLabel)} · {readableLabel(claim.predicate, 'predicate', resolveLabel)}</h4>
      <p>
        <span data-testid="published-answer-quantity">{quantityText(claim.value.value)}</span>{' '}
        <span data-testid="published-answer-unit">{claim.value.unit}</span>
        {' '}<small>{kind}</small>
      </p>
      {renderTimeBinding(claim.time)}
      <EvidenceReferences refs={evidenceRefs} onEvidenceReference={onEvidenceReference} />
    </article>
  )
}

function AssertionView({
  assertion,
  evidenceRefs,
  resolveLabel,
  onEvidenceReference,
}: {
  readonly assertion: VerifiedAssertion
  readonly evidenceRefs: readonly ResourceRef[]
  readonly resolveLabel: PublishedAnswerBodyProps['resolveLabel']
  readonly onEvidenceReference: PublishedAnswerBodyProps['onEvidenceReference']
}): ReactNode {
  const subject = readableLabel(assertion.subject, 'subject', resolveLabel)
  const predicate = readableLabel(assertion.predicate, 'predicate', resolveLabel)
  let content: ReactNode
  switch (assertion.kind) {
    case 'string':
    case 'enum':
      content = <p><strong>{subject} · {predicate}</strong>：<span data-testid="published-answer-value">{assertion.value}</span></p>
      break
    case 'boolean':
      content = <p><strong>{subject} · {predicate}</strong>：<span data-testid="published-answer-boolean">{assertion.value ? '是' : '否'}</span></p>
      break
    case 'entity_ref': {
      const display = assertion.displayName?.trim() || readableLabel(assertion.value.id, 'subject', resolveLabel)
      content = <p><strong>{subject} · {predicate}</strong>：<span data-testid="published-answer-entity">{display}</span></p>
      break
    }
    case 'relation_ref':
      content = (
        <p data-testid="published-answer-relation">
          <strong>{subject} · {predicate}</strong>：
          {readableLabel(assertion.value.from.id, 'subject', resolveLabel)} {'→'}
          {readableLabel(assertion.value.to.id, 'subject', resolveLabel)}
          {' '}（{readableLabel(assertion.value.type, 'predicate', resolveLabel)}）
        </p>
      )
      break
    case 'rule_judgement':
      content = (
        <p data-testid="published-answer-rule-judgement">
          <strong>{subject} · {predicate} · 规则判定（非业务结论）</strong>：<code>{assertion.value}</code>
        </p>
      )
      break
    case 'document_quote':
      content = (
        <>
          <p><strong>{subject} · {predicate}</strong> · {assertion.precision === 'exact' ? '精确引文' : '近似引文'}</p>
          <blockquote data-testid="published-answer-quote"><p>{assertion.quote}</p></blockquote>
        </>
      )
      break
    case 'artifact_summary':
      content = <p>已关联摘要工件；自由文本摘要未在此界面展开。</p>
      break
  }
  return (
    <article data-testid="published-answer-statement" data-kind={assertion.kind}>
      {content}
      {assertion.kind === 'document_quote' ? (
        <p>文档：{readableLabel(assertion.documentRef.id, 'subject', resolveLabel)}</p>
      ) : null}
      <EvidenceReferences refs={evidenceRefs} onEvidenceReference={onEvidenceReference} />
    </article>
  )
}

function safeTechnicalValue(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '不可用'
}

export function PublishedAnswerBody({ answer, resolveLabel, onEvidenceReference }: PublishedAnswerBodyProps) {
  const body = bodyShape(answer.body)
  const content = body === undefined ? undefined : collectContent(body)
  const isHistoryLimited = answer.publicationKind === 'history_limited'
  const isVerified = answer.publicationKind === 'verified'
  const limitations = renderLimitations(answer.limitations)
  const legacyOnly = answer.bodyUnavailableReason === 'legacy_metadata_only'

  return (
    <section aria-label="已发布答案" data-testid="published-answer-body">
      <h2>{isHistoryLimited ? '历史受限答案' : isVerified ? '已核验答案' : '已发布答案'}</h2>
      {!isHistoryLimited && !isVerified ? (
        <p data-testid="published-answer-kind-invalid">发布类型无法识别，不能确认此答案是否为当前结果。</p>
      ) : null}
      {isHistoryLimited ? (
        typeof answer.asOf === 'string' && answer.asOf.length > 0 ? (
          <p data-testid="published-answer-as-of">历史时点：<time dateTime={answer.asOf}>{answer.asOf}</time></p>
        ) : (
          <p data-testid="published-answer-as-of-missing">此为历史受限答案，但缺少asOf时点；不可视为当前结果。</p>
        )
      ) : null}

      {body === undefined ? (
        <p data-testid="published-answer-body-unavailable">
          {legacyOnly
            ? '此历史答案只有发布元数据，没有可读取的正文。'
            : '已发布答案没有可读取或可安全展示的正文。'}
        </p>
      ) : (
        <div data-testid="published-answer-content" data-schema-version={body.schemaVersion}>
          {body.schemaVersion === 'answer-draft@1' ? (
            <p data-testid="published-answer-legacy-note">
              此答案采用旧版正文格式；自由文本已省略，只显示带证据引用的结构化陈述和安全摘要信息。
            </p>
          ) : null}
          {content?.statements.map((statement) =>
            statement.kind === 'claim' ? (
              <ClaimView
                key={statement.key}
                claim={statement.claim}
                evidenceRefs={statement.evidenceRefs}
                resolveLabel={resolveLabel}
                onEvidenceReference={onEvidenceReference}
              />
            ) : (
              <AssertionView
                key={statement.key}
                assertion={statement.assertion}
                evidenceRefs={statement.evidenceRefs}
                resolveLabel={resolveLabel}
                onEvidenceReference={onEvidenceReference}
              />
            ),
          )}
          {content?.legacyEvidenceCount === undefined ? null : (
            <p data-testid="published-answer-legacy-evidence-count">旧版摘要记录的证据条目数：{content.legacyEvidenceCount}</p>
          )}
          {content?.hasDisplayableContent === false ? (
            <p data-testid="published-answer-no-structured-content">正文中没有可安全展示的结构化事实。</p>
          ) : null}
          {content?.hasOmittedContent === true ? (
            <p data-testid="published-answer-omitted-content">部分内容缺少有效结构或证据引用，已省略。</p>
          ) : null}
        </div>
      )}

      {limitations}

      <details data-testid="published-answer-technical-details">
        <summary>核验与版本信息</summary>
        <dl>
          <dt>答案 ID</dt><dd>{safeTechnicalValue(answer.answerId)}</dd>
          <dt>内容哈希</dt><dd>{safeTechnicalValue(answer.contentHash)}</dd>
          <dt>证据清单哈希</dt><dd>{safeTechnicalValue(answer.evidenceManifestHash)}</dd>
          <dt>场景清单哈希</dt><dd>{safeTechnicalValue(answer.scenarioManifestHash)}</dd>
          <dt>核验 ID</dt><dd>{safeTechnicalValue(answer.verificationId)}</dd>
          <dt>正文版本</dt><dd>{body?.schemaVersion ?? '不可用'}</dd>
        </dl>
      </details>
    </section>
  )
}
