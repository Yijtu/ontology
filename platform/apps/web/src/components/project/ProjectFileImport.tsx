import { useEffect, useMemo, useRef, useState } from 'react'
import type { StructuredFormat } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import { importProjectFile } from '../../api/project-workbench'
import type { StructuredProjectImportView } from '../../api/project-workbench'
import { Button, Field } from '../ui'
import { ProjectNotice } from './ProjectNotice'
import { useRequestFence } from './useRequestFence'

const MEDIA: Readonly<Record<StructuredFormat, string>> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  text: 'text/plain',
}
function base64Of(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  return btoa(chunks.join(''))
}

export function ProjectFileImport({
  client,
  projectId,
  readOnly,
  onImported,
}: {
  readonly client: WorkbenchClient
  readonly projectId: string
  readonly readOnly: boolean
  readonly onImported: (result: StructuredProjectImportView) => void | Promise<void>
}) {
  const [file, setFile] = useState<File>()
  const [format, setFormat] = useState<StructuredFormat>('csv')
  const [headerRow, setHeaderRow] = useState('1')
  const [sheetName, setSheetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [result, setResult] = useState<StructuredProjectImportView>()
  const [stopped, setStopped] = useState(false)
  const scope = useMemo(
    () => ({ client, projectId, file, format, headerRow, sheetName }),
    [client, projectId, file, format, headerRow, sheetName],
  )
  const begin = useRequestFence(scope)
  const requestKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    requestKey.current = undefined
    setResult(undefined)
    setError(undefined)
    setBusy(false)
    setStopped(false)
  }, [scope])
  useEffect(() => {
    setFile(undefined)
    setSheetName('')
    setHeaderRow('1')
  }, [projectId])

  const upload = async () => {
    if (file === undefined || busy || readOnly) return
    if (file.size === 0 || file.size > 20 * 1024 * 1024) {
      setError(new Error('请选择 1 字节至 20 MiB 的原始文件。'))
      return
    }
    const selectedHeader = Number(headerRow)
    if (
      (format === 'csv' || format === 'xlsx') &&
      (!Number.isSafeInteger(selectedHeader) || selectedHeader < 1)
    ) {
      setError(new Error('表头行必须是从 1 开始的整数。'))
      return
    }
    const request = begin('import')
    requestKey.current ??= client.newRequestKey()
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    setStopped(false)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!request.current()) return
      const imported = await importProjectFile(
        client,
        projectId,
        {
          format,
          mediaType: MEDIA[format],
          contentEncoding: 'base64',
          content: base64Of(bytes),
          options: {
            ...(format === 'csv' || format === 'xlsx' ? { headerRow: selectedHeader } : {}),
            ...(format === 'xlsx' && sheetName.length > 0 ? { sheetName } : {}),
          },
        },
        requestKey.current,
        request.signal,
      )
      if (!request.current()) return
      setResult(imported)
      requestKey.current = undefined
      await onImported(imported)
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  if (readOnly) return <p>当前为只读权限。可查看已导入的资料与映射。</p>
  return (
    <form
      data-testid="project-file-import"
      className="project-section"
      onSubmit={(event) => {
        event.preventDefault()
        void upload()
      }}
    >
      <h4>上传原始文件</h4>
      <p className="project-source-note">
        系统保存原始字节并解析实际行列。导入与字段确认、数据发布分别进行。
      </p>
      <div className="project-form-grid">
        <Field label="原始文件" hint="CSV、XLSX、JSON 或 UTF-8 文本；最多 20 MiB。">
          {(attributes) => (
            <input
              {...attributes}
              data-testid="project-file"
              type="file"
              accept=".csv,.xlsx,.json,.txt,text/csv,application/json,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(event) => {
                const selected = event.target.files?.[0]
                setFile(selected)
                const extension = selected?.name.split('.').at(-1)?.toLowerCase()
                if (extension === 'csv' || extension === 'xlsx' || extension === 'json') setFormat(extension)
                else if (extension === 'txt') setFormat('text')
              }}
            />
          )}
        </Field>
        <Field label="解析格式">
          {(attributes) => (
            <select
              {...attributes}
              value={format}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'csv' || value === 'xlsx' || value === 'json' || value === 'text')
                  setFormat(value)
              }}
            >
              <option value="csv">CSV 表格</option>
              <option value="xlsx">Excel 工作簿</option>
              <option value="json">JSON 记录</option>
              <option value="text">UTF-8 文本</option>
            </select>
          )}
        </Field>
        {format === 'csv' || format === 'xlsx' ? (
          <Field label="表头行" hint="原文件中的行号，从 1 开始。">
            {(attributes) => (
              <input
                {...attributes}
                type="text"
                inputMode="numeric"
                value={headerRow}
                disabled={busy}
                onChange={(event) => setHeaderRow(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        {format === 'xlsx' ? (
          <Field label="工作表名称（可选）" hint="留空使用解析器的默认工作表；填写时按原文件中的名称读取。">
            {(attributes) => (
              <input
                {...attributes}
                value={sheetName}
                disabled={busy}
                onChange={(event) => setSheetName(event.target.value)}
              />
            )}
          </Field>
        ) : null}
      </div>
      {file === undefined ? null : (
        <p>
          {file.name} · {file.size.toLocaleString()} 字节
        </p>
      )}
      <div className="project-actions">
        <Button
          type="submit"
          variant="primary"
          data-testid="project-file-submit"
          disabled={busy || file === undefined}
        >
          {busy ? '正在保存并解析…' : '导入并解析'}
        </Button>
        {busy ? (
          <Button
            onClick={() => {
              begin('import')
              setBusy(false)
              setStopped(true)
            }}
          >
            停止等待
          </Button>
        ) : null}
      </div>
      {stopped ? <p role="status">已停止等待。请刷新资料列表核对服务端实际完成的结果。</p> : null}
      {error === undefined ? null : <ProjectNotice error={error} onRecover={() => void upload()} />}
      {result === undefined ? null : (
        <div className="project-notice" data-testid="project-file-result" data-status={result.status}>
          <strong>
            {result.status === 'complete'
              ? '解析已完成'
              : result.status === 'incomplete'
                ? '解析不完整'
                : '解析被拒绝'}
          </strong>
          <p>
            共 {result.counts.total} 行 · 成功 {result.counts.succeeded} · 待处理 {result.counts.pending} ·
            失败 {result.counts.failed} · 跳过 {result.counts.skipped}
            {result.reused ? ' · 已复用相同原始文件的解析' : ''}
          </p>
          <p>
            覆盖：{result.coverage.completeness}。文档索引状态：{result.documentIndexState ?? '服务端未报告'}
            。
          </p>
          {result.coverage.notes.map((note, position) => (
            <p key={position}>{note}</p>
          ))}
          <details className="project-audit">
            <summary>原始文件版本</summary>
            <code>
              {result.originalRef.id}@{result.originalRef.version}
            </code>
            <p>
              <code>{result.originalRef.digest}</code>
            </p>
          </details>
        </div>
      )}
    </form>
  )
}
