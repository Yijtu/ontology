import { useCallback, useEffect, useRef, useState } from 'react'
import { isRecord } from '@ontology/contracts'
import type { AssetCandidateBatch, AssetDraftVersion, IndustryWorkspace, ResourceRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { WorkspaceIdentity } from '../workspace-identity'
import { definitionGuard } from '../api/definitions'
import { encodeOriginalBytes, nativeCellText } from '../api/workspace-authoring'
import type { WorkspaceAuthoringContext, WorkspaceSourceCatalogue } from '../api/workspace-authoring'
import { SourceEvidencePane } from './ontology/SourceEvidencePane'
import type { GroundingView } from '../api/ontology'
import { invalidWire, readGrounding } from '../api/ontology'
import { classifyPublicError } from '../state/public-errors'
import type { PublicFailure } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { Button, DataTable, Drawer, Field, StatusBadge } from './ui'
import './ontology/ontology.css'

export type SupportedSourceType = 'text' | 'json' | 'csv' | 'xlsx' | 'pdf' | 'docx'
/** Legacy source-item type retained for callers; normal host corpus revisions are read through WorkspaceSourceCatalogue. */
export interface WorkspaceSource { readonly jobId: string; readonly fileName: string; readonly mediaType: SupportedSourceType; readonly revision: string; readonly documentSetRef: ResourceRef }
export interface WorkspaceSourcesPanelProps {
  readonly client: WorkbenchClient; readonly workspace: IndustryWorkspace; readonly identity: WorkspaceIdentity; readonly readOnly?: boolean
  /** @deprecated Normal host commits the actual corpus atomically; use onWorkspaceChanged for its stored revision. */
  readonly onRegisterSourceSet?: (documentSetRef: ResourceRef, reason: string) => Promise<void>
  readonly onWorkspaceChanged?: (workspace: IndustryWorkspace, draft: AssetDraftVersion) => void
  readonly onContinue?: () => void
}
const mediaTypes: Readonly<Record<string, string>> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }
export function WorkspaceSourcesPanel({ client, workspace, readOnly = false, onWorkspaceChanged, onContinue }: WorkspaceSourcesPanelProps) {
  const [catalogue, setCatalogue] = useState<WorkspaceSourceCatalogue>()
  const [context, setContext] = useState<WorkspaceAuthoringContext>()
  const [failure, setFailure] = useState<PublicFailure>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [file, setFile] = useState<File>()
  const [pastedText, setPastedText] = useState('')
  const [headerRow, setHeaderRow] = useState('1')
  const [dataStartRow, setDataStartRow] = useState('2')
  const [sheetName, setSheetName] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [generationKind, setGenerationKind] = useState('definitions')
  const [preview, setPreview] = useState<GroundingView>()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [fragment, setFragment] = useState('')
  const [batch, setBatch] = useState<AssetCandidateBatch>()
  const inputSnapshots = useRef(new Map<string, { readonly name: string; readonly file: File | undefined; readonly text: string; readonly headerRow: string; readonly dataStartRow: string; readonly sheetName: string }>())
  const inputSnapshot = useRef({ name, file, text: pastedText, headerRow, dataStartRow, sheetName })
  inputSnapshot.current = { name, file, text: pastedText, headerRow, dataStartRow, sheetName }
  const activeWorkspace = useRef('')
  const epoch = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)
  const pending = useRef<{ readonly identity: string; readonly key: string; readonly revision: string } | undefined>(undefined)
  const load = useCallback(async () => {
    const token = ++epoch.current
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort
    setFailure(undefined)
    try {
      const [sources, authoring] = await Promise.all([client.getWorkspaceSources(workspace.workspaceId, abort.signal), client.getWorkspaceAuthoringContext(workspace.workspaceId, abort.signal)])
      if (abort.signal.aborted || epoch.current !== token) return
      if (sources.workspace.workspaceId !== workspace.workspaceId || authoring.workspace.workspaceId !== workspace.workspaceId || sources.draft.revision !== authoring.draft.revision) return invalidWire()
      setCatalogue(sources); setContext(authoring)
      setSelected((old) => old.length === 0 ? sources.sources.map((s) => s.sourceRef.id) : old.filter((id) => sources.sources.some((s) => s.sourceRef.id === id)))
    } catch (error) { if (!abort.signal.aborted && epoch.current === token) setFailure(classifyPublicError(error)) }
  }, [client, workspace.workspaceId, workspace.headRevision])
  useEffect(() => {
    const workspaceId = workspace.workspaceId
    if (activeWorkspace.current !== workspaceId) {
      activeWorkspace.current = workspaceId
      const saved = inputSnapshots.current.get(workspaceId)
      setCatalogue(undefined); setContext(undefined); setSelected([]); setNotice(''); setBatch(undefined); setPreview(undefined); setPreviewOpen(false); setBusy(false); pending.current = undefined
      setFile(saved?.file); setPastedText(saved?.text ?? ''); setName(saved?.name ?? ''); setHeaderRow(saved?.headerRow ?? '1'); setDataStartRow(saved?.dataStartRow ?? '2'); setSheetName(saved?.sheetName ?? '')
    }
    void load()
    return () => { inputSnapshots.current.set(workspaceId, inputSnapshot.current); epoch.current++; controller.current?.abort() }
  }, [load, workspace.workspaceId])
  const upload = async () => {
    if (readOnly || busy || catalogue === undefined || !name.trim() || file === undefined && !pastedText.trim()) return
    const token = epoch.current; const abort = new AbortController(); controller.current = abort; setBusy(true); setFailure(undefined); setNotice('')
    try {
      const bytes = file === undefined ? new TextEncoder().encode(pastedText) : new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > 8_388_608) throw new Error('资料需非空且不超过 8 MiB；更低的部署限制仍由服务端检查。')
      const ext = file?.name.split('.').pop()?.toLowerCase() ?? 'txt'
      const mediaType = mediaTypes[ext]
      if (mediaType === undefined) throw new Error('请选择支持的原始资料格式。')
      const table = ext === 'csv' || ext === 'xlsx'
      if (table && (!/^\d+$/.test(headerRow) || !/^\d+$/.test(dataStartRow) || !Number.isSafeInteger(Number(headerRow)) || !Number.isSafeInteger(Number(dataStartRow)) || Number(headerRow) < 1 || Number(dataStartRow) <= Number(headerRow))) throw new Error('表头行需为正整数，数据起始行须在表头之后。')
      const request = { name: name.trim(), mediaType, contentEncoding: 'base64' as const, content: encodeOriginalBytes(bytes), ...(table ? { options: { headerRow: Number(headerRow), dataStartRow: Number(dataStartRow), ...(sheetName.trim() ? { sheetName: sheetName.trim() } : {}) } } : {}) }
      const identity = JSON.stringify(request)
      if (pending.current?.identity !== identity) pending.current = { identity, key: client.newRequestKey(), revision: catalogue.draft.revision }
      const result = await client.uploadWorkspaceSource(workspace.workspaceId, request, { ifMatch: pending.current.revision, idempotencyKey: pending.current.key, signal: abort.signal })
      if (abort.signal.aborted || token !== epoch.current) return
      pending.current = undefined; setNotice('原始字节已存储并解析，工作区语料已生成真实新版本。解析完成不等于候选已批准或语义已发布。'); setFile(undefined); setPastedText(''); setName('')
      setBusy(false)
      onWorkspaceChanged?.(result.workspace, result.draft)
      await load()
    } catch (error) { if (epoch.current === token) { if (abort.signal.aborted) setNotice('已停止等待，上传写入结果待核对。原始文件与本次请求保留，可刷新后确认或用同一请求重试。'); else setFailure(classifyPublicError(error)) } }
    finally { if (epoch.current === token || !abort.signal.aborted) setBusy(false) }
  }
  const previewSource = async (ref: ResourceRef) => {
    if (catalogue === undefined || busy) return
    const token = epoch.current; const abort = new AbortController(); controller.current = abort; setFailure(undefined)
    try { const value = await readGrounding(client, workspace.workspaceId, [ref], { ifMatch: catalogue.draft.revision, signal: abort.signal }); if (!abort.signal.aborted && epoch.current === token) { setPreview(value); setFragment(''); setPreviewOpen(true) } }
    catch (error) { if (!abort.signal.aborted && epoch.current === token) setFailure(classifyPublicError(error)) }
  }
  const generate = async () => {
    if (readOnly || busy || context === undefined || catalogue === undefined || selected.length === 0) return
    const token = epoch.current; const abort = new AbortController(); controller.current = abort; setBusy(true); setFailure(undefined); setNotice('')
    try {
      const sourceRefs = catalogue.sources.filter((s) => selected.includes(s.sourceRef.id)).map((s) => s.sourceRef)
      const body = generationKind === 'definitions' ? { kinds: ['object', 'attribute', 'relation'], sourceRefs, generationPolicyRef: context.generationPolicyRef, documentSetRef: catalogue.draft.documentSetRef, candidateLimit: context.generationLimits.maxCandidatesPerCall } : { kinds: generationKind === 'rules' ? ['rule'] : ['action'], sourceRefs, generationPolicyRef: context.generationPolicyRef, candidateLimit: context.generationLimits.maxCandidatesPerCall }
      const identity = JSON.stringify({ body, kind: generationKind })
      if (pending.current?.identity !== identity) pending.current = { identity, key: client.newRequestKey(), revision: catalogue.draft.revision }
      const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspace.workspaceId)}/${generationKind === 'definitions' ? 'generations' : 'rule-action-generations'}`
      const value = await client.requestJson('POST', path, { body, ifMatch: pending.current.revision, idempotencyKey: pending.current.key, signal: abort.signal })
      if (abort.signal.aborted || token !== epoch.current) return
      if (!isRecord(value) || !definitionGuard.assetCandidateBatch(value['batch']) || !Array.isArray(value['candidates'])) return invalidWire()
      pending.current = undefined; setBatch(value['batch']); setNotice(`服务端已记录 ${value['candidates'].length} 个候选。请进入候选审核，核对真实依据；生成不会自动批准。`)
    } catch (error) { if (epoch.current === token) { if (abort.signal.aborted) setNotice('已请求停止等待；服务端取消状态与迟到结果以重新读取的实际批次记录为准。'); else setFailure(classifyPublicError(error)) } }
    finally { if (epoch.current === token) setBusy(false) }
  }
  return <section className="ontology-workbench ontology-sources" aria-label="工作区资料准备"><header className="ontology-workflow-head"><div><p className="ontology-eyebrow">本体工作区 · 第 1–2 步 / 5</p><h2>先读懂资料，再生成候选</h2><p>原文和表格数据保留实际版本。资料是待核对的数据，不能授予模型权限。</p></div><Button disabled={busy} onClick={() => void load()}>刷新资料与能力</Button></header>
    {failure === undefined ? null : <PublicStateNotice failure={failure} onRecover={() => void load()} />}{catalogue === undefined ? <p className="ontology-notice">尚未取得真实语料目录。当前部署需要装配资料接口后才能上传或生成；本页不会补造语料引用。</p> : null}{notice ? <p role="status" className="ontology-notice">{notice}</p> : null}
    {!readOnly ? <form onSubmit={(e) => { e.preventDefault(); void upload() }}><div className="ontology-form-grid"><Field label="资料名称">{(a) => <input {...a} required value={name} onChange={(e) => setName(e.target.value)} />}</Field><Field label="选择原始文件" hint="文本、Markdown、PDF、CSV、XLSX；保留原始字节。">{(a) => <input {...a} type="file" accept=".txt,.md,.pdf,.csv,.xlsx" disabled={busy} onChange={(e) => { const next = e.target.files?.[0]; setFile(next); if (next !== undefined) { setName(next.name); setPastedText('') } }} />}</Field></div><Field label="或粘贴文本资料">{(a) => <textarea {...a} disabled={busy || file !== undefined} value={pastedText} onChange={(e) => setPastedText(e.target.value)} />}</Field>{file?.name.match(/\.(csv|xlsx)$/i) ? <div className="ontology-form-grid"><Field label="实际表头所在行">{(a) => <input {...a} value={headerRow} inputMode="numeric" onChange={(e) => setHeaderRow(e.target.value)} />}</Field><Field label="实际数据起始行">{(a) => <input {...a} value={dataStartRow} inputMode="numeric" onChange={(e) => setDataStartRow(e.target.value)} />}</Field><Field label="工作表名称（多表时填写）">{(a) => <input {...a} value={sheetName} onChange={(e) => setSheetName(e.target.value)} />}</Field></div> : null}<Button variant="primary" type="submit" disabled={busy || catalogue === undefined || !name.trim() || file === undefined && !pastedText.trim()}>上传并读取真实资料</Button></form> : <p>只读角色仍可查看真实资料与解析覆盖；上传、生成与确认需要编辑权限。</p>}
    <h3>已保存的资料</h3>{catalogue?.sources.length === 0 ? <p className="ontology-empty">真实语料当前为空，上传后会显示原文版本与解析结果。</p> : catalogue?.sources.map((source, index) => <article key={source.sourceRef.id} className="ontology-source-card"><header className="ontology-pane-heading"><label><input type="checkbox" disabled={busy || readOnly} checked={selected.includes(source.sourceRef.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, source.sourceRef.id] : old.filter((id) => id !== source.sourceRef.id))} /><strong>{source.name ?? `资料 ${index + 1}`}</strong></label><StatusBadge tone={source.previewCoverage === 'complete' ? 'success' : 'warning'}>{source.previewCoverage === 'complete' ? '读取完整' : '读取不完整'} · {({ complete: '解析完成', parsed: '解析完成', partial: '部分解析', failed: '解析失败', pending: '等待解析', processing: '正在解析' } as Readonly<Record<string, string>>)[source.status] ?? '待核对解析状态'}</StatusBadge></header>
      <p>原始解析覆盖：{source.coverage.parsedUnits}/{source.coverage.totalUnits}；跳过 {source.coverage.skippedUnits}。{source.coverage.completeness === "complete" ? "当前预览完整。" : "当前预览有范围限制，不能当作全部原文。"}</p>{source.coverage.skippedReasons.length === 0 ? null : <details><summary>未解析内容与原因</summary><p>{source.coverage.skippedReasons.join("、")}</p></details>}
      {source.tables?.map((table) => <div key={table.tableId}><h4>{table.sheetName ?? table.name ?? '原始表格'} · 表头第 {table.headerRow} 行</h4><DataTable caption="服务端解析的原始表头与数据行"><thead><tr>{table.columns.map((column) => <th key={column.columnIndex}>{column.header || '（空表头）'}</th>)}</tr></thead><tbody>{table.rows.map((row) => <tr key={row.sourceRowKey}>{table.columns.map((column) => <td key={column.columnIndex}>{nativeCellText(row.cells.find((cell) => cell.columnIndex === column.columnIndex))}</td>)}</tr>)}</tbody></DataTable><p className="ontology-hint">预览有上限；表头用于理解字段，不能作为数据行来源。</p></div>)}<Button disabled={busy} onClick={() => void previewSource(source.sourceRef)}>查看真实原文与片段</Button><details><summary>原文、解析与语料固定版本</summary><pre>{JSON.stringify(source, null, 2)}</pre></details></article>)}
    <Drawer open={previewOpen} title="原始资料预览" onClose={() => setPreviewOpen(false)}><SourceEvidencePane value={preview} selected={fragment} onSelect={setFragment} /></Drawer>
    <section className="ontology-generation"><h3>生成候选</h3>{context === undefined ? <p>尚未取得当前环境的真实生成配置。</p> : <><p>{context.models.generationEnabled ? '生成模型已配置。' : '生成模型未配置；仍可读取资料、手动编辑已有候选并确认真实来源。'} 决策模型{context.models.decisionEnabled ? '已配置' : '未配置'}。</p><p className="ontology-hint">每次最多生成 {context.generationLimits.maxCandidatesPerCall} 个候选；最多读取 {context.generationLimits.maxSources} 份资料与 {context.generationLimits.sourceFragments} 个片段。输入上下文上限 {context.generationLimits.sourceContextBytes / 1024} KiB，原始读取上限 {context.generationLimits.sourceReadBytes / 1024} KiB，模型输出长度预算 {context.generationLimits.maxOutputTokens} tokens。剩余额度未提供，不显示推测进度或模型正确率。</p>{!readOnly ? <div className="ontology-actions"><Field label="生成范围">{(a) => <select {...a} value={generationKind} onChange={(e) => setGenerationKind(e.target.value)}><option value="definitions">对象、属性与关系</option><option value="rules">规则候选</option><option value="actions">动作声明候选</option></select>}</Field><Button variant="primary" disabled={busy || !context.models.generationEnabled || selected.length === 0 || selected.length > context.generationLimits.maxSources} onClick={() => void generate()}>从所选真实资料生成候选</Button></div> : null}<details><summary>实际生成策略与工作区固定版本</summary><pre>{JSON.stringify({ generationPolicyRef: context.generationPolicyRef, draft: context.draft }, null, 2)}</pre></details></>}{batch === undefined ? null : <section><h4>当前生成批次</h4><StatusBadge tone={batch.state === 'failed' ? 'danger' : batch.state === 'pending_confirmation' ? 'warning' : 'neutral'}>{batch.state === 'failed' ? '生成失败' : batch.state === 'pending_confirmation' ? '生成结束，来源仍待确认' : '生成结束，候选尚需审核'}</StatusBadge><p>实际候选 {batch.counts.total} 项 · 来源待确认 {batch.counts.pendingConfirmation} 项 · 待人工审核 {batch.counts.pendingReview} 项 · 失败 {batch.counts.failed} 项。</p><p>工作区修订：{batch.inputDraftRef.revision}。来源覆盖与失败原因以实际原文读取及本批次记录为准，候选数不代表发布数。</p>{batch.error === undefined ? null : <PublicStateNotice failure={classifyPublicError(batch.error)} />}<details><summary>高级：服务端记录的完整生成批次</summary><pre>{JSON.stringify(batch, null, 2)}</pre></details></section>}{onContinue === undefined ? null : <Button disabled={busy} onClick={onContinue}>继续编辑与审核候选 →</Button>}</section>{busy ? <Button onClick={() => controller.current?.abort()}>停止等待并保留当前输入</Button> : null}
  </section>
}
