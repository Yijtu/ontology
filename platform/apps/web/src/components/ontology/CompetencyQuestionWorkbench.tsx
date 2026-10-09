import { useEffect, useRef, useState } from 'react'
import { isRecord, isVersionRef } from '@ontology/contracts'
import type { VersionRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import { canonicalBody, expectationText, parseCompetencyDeclaration, replaceOriginalRef, selectCompetencyQuestions } from '../../api/competency'
import type { CompetencyDeclarationView } from '../../api/competency'
import { invalidWire, readHumanReviews } from '../../api/ontology'
import { webWorkspaceIdentity } from '../../workspace-identity'
import { classifyPublicError } from '../../state/public-errors'
import type { PublicFailure } from '../../state/public-errors'
import { PublicStateNotice } from '../PublicStateNotice'
import { ExpectationEditor } from './ExpectationEditor'
import { Button, Field, StatusBadge } from '../ui'

export function CompetencyQuestionWorkbench({ client, workspaceId, readOnly, onApprovedRef, disabled = false }: { readonly client: WorkbenchClient; readonly workspaceId: string; readonly readOnly: boolean; readonly disabled?: boolean; readonly onApprovedRef: (ref: VersionRef | undefined) => void }) {
  const [declaration, setDeclaration] = useState<CompetencyDeclarationView>()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [storedRef, setStoredRef] = useState<VersionRef>()
  const [storedConfirmed, setStoredConfirmed] = useState(false)
  const proposals = useRef(new Map<string, VersionRef>())
  const [approved, setApproved] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = busy || disabled
  const [failure, setFailure] = useState<PublicFailure>()
  const [refText, setRefText] = useState('')
  const [bodyText, setBodyText] = useState('')
  const [notice, setNotice] = useState('')
  const epoch = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)
  const changed = () => { setStoredRef(undefined); setStoredConfirmed(false); setApproved(false); onApprovedRef(undefined); setNotice('内容发生变化。保存为新题集后需要新的人工批准。') }
  useEffect(() => { epoch.current++; controller.current?.abort(); setBusy(false); setDeclaration(undefined); setSelected([]); setStoredRef(undefined); setStoredConfirmed(false); setApproved(false); setReason(''); setFailure(undefined); setNotice(''); setBodyText(''); setRefText(''); onApprovedRef(undefined); return () => { epoch.current++; controller.current?.abort() } }, [workspaceId])
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (locked) return
    const token = epoch.current
    const abort = new AbortController(); controller.current = abort; setBusy(true); setFailure(undefined)
    try { await task(abort.signal) } catch (error) { if (epoch.current === token && !abort.signal.aborted) setFailure(classifyPublicError(error)); else if (epoch.current === token) setNotice('已停止等待，写入结果需重新读取确认。') }
    finally { if (epoch.current === token) setBusy(false) }
  }
  const assign = (value: unknown) => { const next = parseCompetencyDeclaration(value); setDeclaration(next); setSelected(next.questions.map((q) => q.questionId)); setBodyText(JSON.stringify(next.body, null, 2)); changed() }
  const readExact = () => void run(async (signal) => {
    const ref: unknown = JSON.parse(refText)
    if (!isVersionRef(ref)) return invalidWire()
    const value = await client.requestJson('POST', '/api/v1/competency-question-sets/read', { body: { ref }, signal })
    if (signal.aborted) return
    if (!isRecord(value) || typeof value['approved'] !== 'boolean') return invalidWire()
    const next = parseCompetencyDeclaration(value['declaration']); proposals.current.delete(`${workspaceId}:${ref.digest}`); setDeclaration(next); setSelected(next.questions.map((q) => q.questionId)); setBodyText(JSON.stringify(next.body, null, 2)); setStoredRef(ref); setStoredConfirmed(true); setApproved(value['approved']); onApprovedRef(value['approved'] ? ref : undefined)
  })
  const save = () => void run(async (signal) => {
    if (declaration === undefined) return
    const body = selectCompetencyQuestions(declaration, selected)
    const digest = await webWorkspaceIdentity.sha256(canonicalBody(body))
    if (signal.aborted) return
    const proposalKey = `${workspaceId}:${digest}`
    const ref = proposals.current.get(proposalKey) ?? { id: webWorkspaceIdentity.newId(), version: '1.0.0', digest }
    proposals.current.set(proposalKey, ref); setStoredRef(ref); setStoredConfirmed(false); setRefText(JSON.stringify(ref))
    const value = await client.requestJson('POST', '/api/v1/competency-question-sets', { body: { ref, body }, signal })
    if (signal.aborted) return
    if (!isRecord(value) || value['approvalRequired'] !== true || value['candidateId'] !== ref.id) return invalidWire()
    const next = parseCompetencyDeclaration(value['declaration']); if (next.ref?.digest !== digest || next.ref.id !== ref.id) return invalidWire()
    proposals.current.delete(proposalKey)
    setDeclaration(next); setStoredRef(ref); setStoredConfirmed(true); setSelected(next.questions.map((q) => q.questionId)); setBodyText(JSON.stringify(next.body, null, 2)); setApproved(false); onApprovedRef(undefined); setNotice('新题集已存入实际审核库，尚未人工批准；旧题集不受本次选择影响。')
  })
  const approve = () => void run(async (signal) => {
    if (storedRef === undefined || !storedConfirmed || !reason.trim()) return
    const reviews = await readHumanReviews(client, storedRef.id, signal)
    const latest = reviews.reduce<string>((revision, r) => BigInt(r.revision) > BigInt(revision) ? r.revision : revision, '0')
    await client.requestJson('POST', `/api/v1/candidates/${storedRef.id}/reviews`, { body: { decision: 'approve', reason }, ifMatch: latest, signal })
    const value = await client.requestJson('POST', '/api/v1/competency-question-sets/read', { body: { ref: storedRef }, signal })
    if (signal.aborted) return
    if (!isRecord(value) || value['approved'] !== true) return invalidWire()
    setApproved(true); onApprovedRef(storedRef); setNotice('当前题集内容已由人工批准，可交给服务端验核当前工作区。')
  })
  const updateQuestion = (id: string, update: Readonly<Record<string, unknown>>) => {
    if (declaration === undefined || !Array.isArray(declaration.body['questions'])) return
    const body = { ...declaration.body, questions: declaration.body['questions'].map((q: unknown) => isRecord(q) && q['questionId'] === id ? { ...q, ...update } : q) }
    setDeclaration(parseCompetencyDeclaration(body)); setBodyText(JSON.stringify(body, null, 2)); changed()
  }
  const originals = declaration !== undefined && Array.isArray(declaration.body['sourceRefs']) ? declaration.body['sourceRefs'].filter(isVersionRef) : []
  return <section className="ontology-cq"><header className="ontology-pane-heading"><div><h3>业务能力问题</h3><p>用独立编写的期望结果验核当前版本。合成验核不代表客户验收或真实模型质量。</p></div><StatusBadge tone={approved ? 'success' : 'warning'}>{approved ? '当前题集已人工批准' : storedRef === undefined ? '尚未保存新题集' : !storedConfirmed ? '保存结果待核对' : '等待新的人工批准'}</StatusBadge></header>
    {failure === undefined ? null : <PublicStateNotice failure={failure} />}{notice ? <p role="status" className="ontology-notice">{notice}</p> : null}
    <details><summary>读取已有题集的精确版本</summary><Field label="题集版本引用">{(a) => <textarea {...a} disabled={locked} value={refText} onChange={(e) => setRefText(e.target.value)} />}</Field><Button disabled={locked || !refText.trim()} onClick={readExact}>读取原题集与当前审批</Button></details>
    {!readOnly ? <Field label="导入独立编写的题集文件" hint="选择正式题集 JSON。导入不会自动改写期望结果或产生人工批准。">{(a) => <input {...a} type="file" accept=".json,application/json" disabled={locked} onChange={(e) => { const file = e.target.files?.[0]; if (file === undefined) return; void run(async (signal) => { if (file.size > 8_388_608) throw new Error('题集文件超过 8 MiB。'); const value: unknown = JSON.parse(await file.text()); if (!signal.aborted) assign(value) }) }} />}</Field> : null}
    {declaration === undefined ? <p className="ontology-empty">尚未读取题集。请导入已独立编写的题集，或读取已有精确版本。</p> : <><p className="ontology-notice">显式选择适合当前版本的问题，会编写并保存一个全新的题集。原有异构版本题集继续保留；运行时不会自动跳过不兼容的问题。</p><ul className="ontology-question-list">{declaration.questions.map((q) => <li key={q.questionId}><label><input type="checkbox" disabled={readOnly || busy} checked={selected.includes(q.questionId)} onChange={(e) => { setSelected((old) => e.target.checked ? [...old, q.questionId] : old.filter((id) => id !== q.questionId)); changed() }} /><strong>{q.question}</strong></label><p>独立期望：{expectationText(q.expected)}</p>{!readOnly ? <details><summary>编辑业务问题与独立期望（生成新题集）</summary><Field label="业务问题">{(a) => <textarea {...a} disabled={locked} value={q.question} onChange={(e) => updateQuestion(q.questionId, { question: e.target.value })} />}</Field><ExpectationEditor value={q.expected} onChange={(expected) => updateQuestion(q.questionId, { expected })} disabled={locked} /><p className="ontology-hint">独立期望由人编写；不会使用当前运行结果自动修正。</p></details> : null}<p className="ontology-hint">所需能力：{q.requiredCapabilities.join('、')}</p><details><summary>问题版本与独立期望明细</summary><pre>{JSON.stringify(q, null, 2)}</pre></details></li>)}</ul>
      {!readOnly ? <details><summary>把声明来源绑定到实际上传的原文</summary><p>每份来源单独上传原始字节。保留已有原文偏移与独立期望，服务端会校验摘要和真实引用。</p>{originals.map((original, index) => <Field key={original.id} label={`原文资料 ${index + 1}`}>{(a) => <input {...a} type="file" accept=".txt,.csv,.json" disabled={locked} onChange={(e) => { const file = e.target.files?.[0]; if (file === undefined) return; void run(async (signal) => { if (file.size > 8_388_608) throw new Error('单份原文超过 8 MiB。'); const mediaType = file.name.endsWith('.csv') ? 'text/csv' : file.name.endsWith('.json') ? 'application/json' : 'text/plain'; const value = await client.requestBytes('POST', '/api/v1/competency-question-sources', new Uint8Array(await file.arrayBuffer()), { mediaType, signal }); if (signal.aborted) return; if (!isRecord(value) || !isVersionRef(value['sourceRef'])) return invalidWire(); assign(replaceOriginalRef(declaration.body, original, value['sourceRef'])) }) }} />}</Field>)}</details> : null}
      <details><summary>高级：完整题集结构与版本</summary><pre>{JSON.stringify(storedRef, null, 2)}</pre><Field label="完整题集内容" hint="结构修改只作为待验证的新声明，服务端执行完整规范校验。">{(a) => <textarea {...a} disabled={readOnly || busy} rows={12} value={bodyText} onChange={(e) => { setBodyText(e.target.value); changed() }} />}</Field>{!readOnly ? <Button disabled={locked} onClick={() => { try { assign(JSON.parse(bodyText)) } catch (error) { setFailure(classifyPublicError(error)) } }}>应用结构编辑到待保存题集</Button> : null}</details>
      {!readOnly ? <><Button variant="primary" disabled={locked || selected.length === 0 || storedConfirmed} onClick={save}>保存为全新题集</Button><Field label="新题集人工审核意见">{(a) => <textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field><Button disabled={locked || storedRef === undefined || !storedConfirmed || !reason.trim() || approved} onClick={approve}>人工批准当前新题集</Button></> : null}
    </>}{busy ? <Button onClick={() => controller.current?.abort()}>停止等待（结果待核对）</Button> : null}
  </section>
}
