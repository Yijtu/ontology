import { useCallback, useEffect, useState } from 'react'
import type { MappingRef, ProjectRecord, ResolvedProfileRef, ResourceRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type { IndustryPackSummary } from '../api/projects'
import {
  SYNTHETIC_CASE_KIND_LABELS,
  type IndustryValidationGate,
  type IndustryValidationReportView,
  type PackExportBundleView,
  type PublishedPackResultView,
  type SyntheticCaseKind,
  type SyntheticExampleSetView,
  type ValidationSurfaceGateView,
} from '../api/package-publication'
import { StatePanel } from './StatePanel'
import { PublicStateNotice } from './PublicStateNotice'
import { classifyPublicError } from '../state/public-errors'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'

/**
 * The package validation / publish / export / project-mount frontend (V03-021 / #202,
 * SPEC v0.3a asset-data-ui §6.1/§9.2, SPEC generic-assistants-core v0.3 §4.3, A.US-005, P.US-009/011).
 *
 * It renders four real operations over HTTP:
 *  - the isolation-marked synthetic counter-examples and the industry validation report, with
 *    `semanticPublished` and `deploymentExecutable` shown as two independent surfaces;
 *  - publication, blocked when the report is not publishable (and, optionally, when the deployment
 *    surface is not fully executable) — a blocked draft never shows as a successful publish;
 *  - the immutable pack catalogue plus an on-demand export carrying the content digest and the
 *    version diff, and never a customer instance or price table;
 *  - mounting an exact published pack version into a project, or an explicit blocker naming the
 *    maintainer action when this deployment has not bound the project's profile/mapping.
 *
 * The panel never names an industry: it is a generic public home mounted through the V03-022 shell.
 */

export interface PackageMountBinding {
  readonly profileRef: ResolvedProfileRef
  readonly mappingRefs: readonly MappingRef[]
  readonly documentSetRef: ResourceRef
}

export interface PackagePublicationPanelProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  /** The deployment-resolved profile/mapping a new project mounts the pack with. */
  readonly mountBinding?: PackageMountBinding
  /** When set, the pack is mounted onto this existing project instead of creating a new one. */
  readonly existingProjectId?: string
  /** The validation report to open on load (a freshly created report from the workbench). */
  readonly initialValidationId?: string
  readonly readOnly?: boolean
}

/** The counter-example families a validation report proves were covered. */
export function coveredCaseKinds(
  exampleSet: SyntheticExampleSetView | undefined,
  report: IndustryValidationReportView | undefined,
): readonly { readonly kind: SyntheticCaseKind; readonly covered: boolean }[] {
  const kinds = exampleSet?.caseKinds ?? []
  const covered = new Set((report?.coverage ?? []).map((entry) => entry.caseKind))
  return kinds.map((kind) => ({ kind, covered: covered.has(kind) }))
}

export function expectationSummary(results: IndustryValidationReportView['expectationResults']): {
  readonly matched: number
  readonly mismatched: number
  readonly total: number
} {
  const matched = results.filter((entry) => entry.matched).length
  return { matched, mismatched: results.length - matched, total: results.length }
}

/** Whether publication is blocked locally: the semantic surface always gates, execution is opt-in. */
export function publicationBlocked(
  report: IndustryValidationReportView | undefined,
  requireDeploymentExecutable: boolean,
): boolean {
  if (report === undefined) return true
  if (!report.semanticPublished.passed) return true
  if (requireDeploymentExecutable && !report.deploymentExecutable.passed) return true
  return false
}

export function gateLabel(gate: IndustryValidationGate): string {
  switch (gate) {
    case 'open':
      return '验证通过'
    case 'blocked_semantic':
      return '语义验证阻断'
    case 'blocked_execution':
      return '部署执行阻断'
    case 'blocked_both':
      return '语义与部署均阻断'
  }
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      missingCapabilities: error.missingCapabilities,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '请求无法完成。', retryable: true }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError && error.permissionDenied) return 'permission_denied'
  return 'failure'
}

function SurfaceView({
  surface,
  gate,
}: {
  readonly surface: 'semantic' | 'deployment'
  readonly gate: ValidationSurfaceGateView
}) {
  return (
    <section
      className={`package-publication__surface package-publication__surface--${surface}`}
      data-testid={`validation-surface-${surface}`}
      data-passed={gate.passed}
    >
      <h4>{surface === 'semantic' ? '语义已发布' : '当前部署可执行'}</h4>
      <p data-testid={`validation-surface-${surface}-status`}>
        {gate.passed ? '通过' : `${String(gate.blockers.length)} 个阻断项`}
      </p>
      {gate.blockers.length === 0 ? null : (
        <ul data-testid={`validation-blockers-${surface}`}>
          {gate.blockers.map((blocker, index) => (
            <li key={`${blocker.code}:${String(index)}`} data-testid={`validation-blocker-${surface}`}>
              {blocker.code}: {blocker.message}
              {blocker.logicalId === undefined ? '' : `（${blocker.logicalId}）`}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function PackagePublicationPanel({
  client,
  workspaceId,
  mountBinding,
  existingProjectId,
  initialValidationId,
  readOnly = false,
}: PackagePublicationPanelProps) {
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<WorkbenchError | undefined>(undefined)

  const [packs, setPacks] = useState<readonly IndustryPackSummary[]>([])
  const [exampleSets, setExampleSets] = useState<readonly SyntheticExampleSetView[]>([])
  const [report, setReport] = useState<IndustryValidationReportView | undefined>(undefined)
  const [selectedExampleSetId, setSelectedExampleSetId] = useState<string | undefined>(undefined)

  const [packId, setPackId] = useState('')
  const [packVersion, setPackVersion] = useState('1.0.0')
  const [requireDeploymentExecutable, setRequireDeploymentExecutable] = useState(false)
  const [publication, setPublication] = useState<PublishedPackResultView | undefined>(undefined)

  const [exportBundle, setExportBundle] = useState<PackExportBundleView | undefined>(undefined)

  const [projectTitle, setProjectTitle] = useState('')
  const [mountedProject, setMountedProject] = useState<ProjectRecord | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const [packList, setList] = await Promise.all([
        client.listIndustryPacks(),
        client.listSyntheticExampleSets(workspaceId),
      ])
      setPacks(packList)
      setExampleSets(setList)
      const loaded = initialValidationId === undefined ? undefined : await client.getValidation(workspaceId, initialValidationId)
      setReport(loaded)
      setSelectedExampleSetId((previous) => loaded?.exampleSetId ?? previous ?? setList[0]?.exampleSetId)
      setPhase('ready')
    } catch (caught) {
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client, workspaceId, initialValidationId])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      setBusy(true)
      setActionError(undefined)
      try {
        await operation()
      } catch (caught) {
        setActionError(toError(caught))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const selectedExampleSet = exampleSets.find((set) => set.exampleSetId === selectedExampleSetId)

  const runValidation = (): void => {
    if (selectedExampleSetId === undefined) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请选择一个合成样例集后再运行验证。' })
      return
    }
    const expectedRevision = report?.revision ?? selectedExampleSet?.targetDraftRef?.version
    void run(async () => {
      const next = await client.createSyntheticValidation(workspaceId, {
        exampleSetId: selectedExampleSetId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      })
      setReport(next)
      setSelectedExampleSetId(next.exampleSetId)
      setPublication(undefined)
    })
  }

  const publish = (): void => {
    if (report === undefined) {
      setActionError({ code: 'REVISION_REQUIRED', message: '没有可发布验证结果，请先运行合成验证。' })
      return
    }
    if (publicationBlocked(report, requireDeploymentExecutable)) {
      setActionError({
        code: 'VALIDATION_BLOCKED',
        message: requireDeploymentExecutable
          ? '发布被阻断：报告未通过语义验证或部署执行面。'
          : '发布被阻断：报告未通过语义验证。',
      })
      return
    }
    const trimmedPackId = packId.trim()
    if (trimmedPackId.length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写包 ID。' })
      return
    }
    void run(async () => {
      const result = await client.publishPack(workspaceId, {
        packId: trimmedPackId,
        version: packVersion.trim(),
        validationId: report.validationId,
        requireDeploymentExecutable,
        expectedRevision: report.revision,
      })
      setPublication(result)
      const refreshed = await client.listIndustryPacks()
      setPacks(refreshed)
    })
  }

  const exportPack = (summary: IndustryPackSummary): void => {
    const ref = summary.packRef
    if (ref === undefined) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '该条目没有可导出的精确版本。' })
      return
    }
    void run(async () => {
      const bundle = await client.exportIndustryPack(ref.id, ref.version)
      setExportBundle(bundle)
    })
  }

  const mount = (summary: IndustryPackSummary): void => {
    const ref = summary.packRef
    if (ref === undefined) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '该条目没有可挂载的精确版本。' })
      return
    }
    if (projectTitle.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写项目标题。' })
      return
    }
    if (mountBinding === undefined && existingProjectId === undefined) {
      setActionError({
        code: 'CAPABILITY_NOT_CONFIGURED',
        message: '该部署未绑定项目的 profile 与 mapping；由维护者在授权工作区配置后才能挂载。',
      })
      return
    }
    void run(async () => {
      if (mountBinding !== undefined) {
        const created = await client.createProject({
          title: projectTitle.trim(),
          industryPackRef: ref,
          profileRef: mountBinding.profileRef,
          mappingRefs: mountBinding.mappingRefs,
          documentSetRef: mountBinding.documentSetRef,
        })
        setMountedProject(created.project)
        return
      }
      const projectId = existingProjectId
      if (projectId === undefined) return
      const project = await client.getProject(projectId)
      const view = await client.mountProjectPack(projectId, {
        expectedRevision: project.headRevision,
        industryPackRef: ref,
        reason: '从工作台挂载新发布包',
      })
      setMountedProject(view.project)
    })
  }

  const mountablePacks = packs.filter((summary): summary is IndustryPackSummary & { readonly packRef: NonNullable<IndustryPackSummary['packRef']> } =>
    summary.packRef !== undefined && summary.usable,
  )
  const summary = report === undefined ? undefined : expectationSummary(report.expectationResults)
  const blocked = publicationBlocked(report, requireDeploymentExecutable)

  return (
    <section
      className="package-publication"
      data-testid="package-publication"
      data-phase={phase}
      data-workspace-id={workspaceId}
    >
      <header className="panel__header">
        <h2>包验证、发布、导出与项目挂载</h2>
        <p className="panel__hint">
          合成反例只用于验证；语义发布与当前部署可执行是两个独立结论。导出为不可变声明包，不含客户实例与真实价表。
        </p>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载包发布工作台…' } : {})}
          {...(phase === 'failure' ? { onRecover: () => void load() } : {})}
        />
      ) : null}

      {actionError === undefined ? null : (
        <PublicStateNotice
          testId="package-action-failure"
          failure={classifyPublicError(actionError)}
          onRecover={() => void load()}
        />
      )}

      {phase === 'ready' ? (
        <>
          <section className="package-publication__sandbox" data-testid="validation-sandbox">
            <h3>合成验证与反例</h3>
            {exampleSets.length === 0 ? (
              <p data-testid="validation-sandbox-empty">当前没有合成样例集。</p>
            ) : (
              <ul data-testid="validation-example-sets" data-count={exampleSets.length}>
                {exampleSets.map((set) => (
                  <li key={set.exampleSetId} data-testid="validation-example-set" data-example-set-id={set.exampleSetId}>
                    <label>
                      <input
                        type="radio"
                        name="example-set"
                        data-testid="validation-example-set-select"
                        checked={set.exampleSetId === selectedExampleSetId}
                        disabled={busy}
                        onChange={() => setSelectedExampleSetId(set.exampleSetId)}
                      />
                      {set.exampleSetId.slice(0, 8)} · 标记：{set.isolationLabel}
                    </label>
                    <ul data-testid="validation-counterexamples">
                      {set.cases.map((counterExample) => (
                        <li
                          key={counterExample.caseId}
                          data-testid="validation-counterexample"
                          data-case-kind={counterExample.caseKind}
                          data-isolation={set.isolationLabel}
                        >
                          {SYNTHETIC_CASE_KIND_LABELS[counterExample.caseKind]} · {counterExample.objectTypeRef}
                          {counterExample.displayName === undefined ? '' : ` · ${counterExample.displayName}`}
                          {counterExample.alternateObjectTypeRef === undefined
                            ? ''
                            : ` ↔ ${counterExample.alternateObjectTypeRef}`}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {readOnly ? null : (
              <button
                type="button"
                data-testid="validation-run"
                disabled={busy || selectedExampleSetId === undefined}
                onClick={runValidation}
              >
                运行合成验证
              </button>
            )}
          </section>

          {report === undefined ? (
            <p data-testid="validation-report-missing">尚未运行验证，无法查看反例结果或发布。</p>
          ) : (
            <section className="package-publication__report" data-testid="validation-report" data-gate={report.gate}>
              <h3>验证报告</h3>
              <p data-testid="validation-publishable" data-publishable={report.publishable}>
                {report.publishable ? '可发布。' : `发布受阻：${gateLabel(report.gate)}。`}
              </p>
              <p data-testid="validation-isolation">
                标记 {report.isolationLabel} · 数据模式 {report.dataMode} · 业务批准 {report.businessApproval} · 写入真实事实 {String(report.realFactsWritten)}
              </p>

              <div className="package-publication__surfaces">
                <SurfaceView surface="semantic" gate={report.semanticPublished} />
                <SurfaceView surface="deployment" gate={report.deploymentExecutable} />
              </div>

              {summary === undefined ? null : (
                <p data-testid="validation-expectation-summary">
                  期望匹配 {summary.matched}/{summary.total}，反例不一致 {summary.mismatched}
                </p>
              )}
              <ul data-testid="validation-case-coverage">
                {coveredCaseKinds(selectedExampleSet, report).map((entry) => (
                  <li key={entry.kind} data-testid="validation-coverage-item" data-covered={entry.covered}>
                    {SYNTHETIC_CASE_KIND_LABELS[entry.kind]}：{entry.covered ? '已覆盖' : '未覆盖'}
                  </li>
                ))}
              </ul>
              <ul data-testid="validation-expectations">
                {report.expectationResults.map((result, index) => (
                  <li
                    key={`${result.expectationId}:${String(index)}`}
                    data-testid="validation-expectation"
                    data-matched={result.matched}
                  >
                    {result.origin} · 期望 {result.expected} · 实际 {result.actual} ·
                    {result.matched ? '匹配' : '不一致'}
                    {result.independent ? '' : '（非独立来源）'}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="package-publication__publish" data-testid="asset-publish-section">
            <h3>发布不可变包</h3>
            <label>
              包 ID
              <input
                type="text"
                data-testid="asset-publish-pack-id"
                value={packId}
                disabled={busy || readOnly}
                onChange={(event) => setPackId(event.target.value)}
              />
            </label>
            <label>
              版本
              <input
                type="text"
                data-testid="asset-publish-version"
                value={packVersion}
                disabled={busy || readOnly}
                onChange={(event) => setPackVersion(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                data-testid="asset-publish-require-executable"
                checked={requireDeploymentExecutable}
                disabled={busy || readOnly}
                onChange={(event) => setRequireDeploymentExecutable(event.target.checked)}
              />
              要求部署可执行（否则仅语义发布）
            </label>
            {readOnly ? null : (
              <button type="button" data-testid="asset-publish" disabled={busy || blocked} onClick={publish}>
                发布
              </button>
            )}
            {blocked && !readOnly ? (
              <p data-testid="asset-publish-blocker">
                {report === undefined ? '没有验证报告。' : '发布受阻：先修复验证/执行阻断项，或仅做语义发布。'}
              </p>
            ) : null}
            {publication === undefined ? null : (
              <div data-testid="publication-result" data-pack-ref={`${publication.packRef.id}@${publication.packRef.version}`}>
                <p data-testid="publication-pack-ref">
                  已发布 {publication.packRef.id}@{publication.packRef.version}（修订 {publication.revision}）
                </p>
                <p
                  data-testid="publication-semantic-published"
                  data-published={publication.capabilities.semanticPublished}
                >
                  语义已发布：{publication.capabilities.semanticPublished ? '是' : '否'}
                </p>
                <p
                  data-testid="publication-deployment-executable"
                  data-executable={publication.capabilities.deploymentExecutable}
                >
                  当前部署可执行：{publication.capabilities.deploymentExecutable ? '是' : '否'}
                </p>
                {publication.capabilities.missingCapabilities.length === 0 ? null : (
                  <ul data-testid="publication-missing-capabilities">
                    {publication.capabilities.missingCapabilities.map((capability) => (
                      <li key={capability} data-testid="publication-missing-capability">
                        缺少能力：{capability}（由维护者绑定）
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="package-publication__versions" data-testid="pack-versions">
            <h3>已发布版本</h3>
            {packs.length === 0 ? (
              <p data-testid="pack-versions-empty">尚无已发布包版本。</p>
            ) : (
              <ul data-testid="pack-version-list">
                {packs.map((entry, index) => (
                  <li
                    key={`${entry.namespace}:${entry.packRef?.version ?? String(index)}`}
                    data-testid="pack-version"
                    data-maturity={entry.maturityLabel}
                    data-usable={entry.usable}
                  >
                    <span data-testid="pack-version-ref">
                      {entry.packRef === undefined ? entry.namespace : `${entry.packRef.id}@${entry.packRef.version}`}
                    </span>
                    <span data-testid="pack-version-maturity">{entry.maturityLabel}</span>
                    {readOnly || entry.packRef === undefined ? null : (
                      <button
                        type="button"
                        data-testid="pack-export"
                        data-pack-ref={`${entry.packRef.id}@${entry.packRef.version}`}
                        disabled={busy}
                        onClick={() => exportPack(entry)}
                      >
                        导出
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {exportBundle === undefined ? null : (
            <section className="package-publication__export" data-testid="pack-export-result">
              <h3>不可变导出</h3>
              <p data-testid="pack-export-digest">内容摘要：{exportBundle.contentDigest}</p>
              <p data-testid="pack-export-ref">
                {exportBundle.packRef.id}@{exportBundle.packRef.version} · {exportBundle.maturityLabel} ·
                映射模板 {exportBundle.mappingTemplates.length} 项
              </p>
              {exportBundle.versionDiff === undefined ? null : (
                <div data-testid="pack-version-diff">
                  <p data-testid="pack-version-diff-summary">
                    相对上一版本变更 {exportBundle.versionDiff.changes.length} 项，破坏性 {exportBundle.versionDiff.breakingChanges.length} 项
                  </p>
                  <ul data-testid="pack-version-diff-changes">
                    {exportBundle.versionDiff.changes.map((change, index) => (
                      <li key={`${change.logicalId}:${String(index)}`} data-testid="pack-version-diff-change" data-breaking={change.breaking}>
                        {change.change} · {change.logicalId} · {change.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {exportBundle.capabilityStatus === undefined ? null : (
                <p
                  data-testid="pack-export-capability"
                  data-semantic={exportBundle.capabilityStatus.semanticPublished}
                  data-executable={exportBundle.capabilityStatus.deploymentExecutable}
                >
                  语义已发布 {String(exportBundle.capabilityStatus.semanticPublished)} · 部署可执行 {String(exportBundle.capabilityStatus.deploymentExecutable)}
                </p>
              )}
            </section>
          )}

          <section className="package-publication__mount" data-testid="project-mount">
            <h3>挂载到项目</h3>
            {mountBinding === undefined && existingProjectId === undefined ? (
              <p data-testid="project-mount-blocker" data-code="CAPABILITY_NOT_CONFIGURED">
                该部署未提供项目 profile/mapping 绑定，无法挂载；由维护者在授权工作区配置执行能力后再试。
              </p>
            ) : null}
            <label>
              项目标题
              <input
                type="text"
                data-testid="project-mount-title"
                value={projectTitle}
                disabled={busy || readOnly}
                onChange={(event) => setProjectTitle(event.target.value)}
              />
            </label>
            {readOnly ? null : (
              <ul data-testid="project-mount-packs">
                {mountablePacks.length === 0 ? (
                  <li data-testid="project-mount-empty">没有可挂载的可用包版本。</li>
                ) : (
                  mountablePacks.map((entry) => (
                    <li key={`${entry.namespace}:${entry.packRef.version}`}>
                      <button
                        type="button"
                        data-testid="project-mount-submit"
                        data-pack-ref={`${entry.packRef.id}@${entry.packRef.version}`}
                        disabled={busy}
                        onClick={() => mount(entry)}
                      >
                        挂载 {entry.packRef.id}@{entry.packRef.version}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
            {mountedProject === undefined ? null : (
              <p data-testid="project-mount-result" data-project-id={mountedProject.projectId}>
                已挂载到项目 {mountedProject.title}（{mountedProject.projectId}，修订 {mountedProject.headRevision}）
              </p>
            )}
          </section>
        </>
      ) : null}
    </section>
  )
}
