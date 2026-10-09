import { useEffect, useMemo, useState } from 'react'
import type { InstanceRecordView } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import { readInstanceFieldSource } from '../../api/source-views'
import type { InstanceFieldSourceView } from '../../api/source-views'
import { ProjectNotice } from './ProjectNotice'
import { SourceFragmentContent } from './SourceFragmentContent'
import { useRequestFence } from './useRequestFence'

export function CurrentInstanceFieldSource({ client, record, fieldId, reload }: { readonly client: WorkbenchClient; readonly record: InstanceRecordView; readonly fieldId: string; readonly reload: () => Promise<void> }) {
  const scope = useMemo(() => ({ client, record, fieldId }), [client, record, fieldId])
  const begin = useRequestFence(scope)
  const [loaded, setLoaded] = useState<{ owner: unknown; view: InstanceFieldSourceView }>()
  const [failure, setFailure] = useState<{ owner: unknown; error: unknown }>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const request = begin('original-field')
    setLoaded(undefined); setFailure(undefined); setLoading(true)
    void readInstanceFieldSource(client, record, fieldId, request.signal).then((view) => {
      if (request.current()) setLoaded({ owner: scope, view })
    }).catch((caught: unknown) => { if (request.current()) setFailure({ owner: scope, error: caught }) }).finally(() => { if (request.current()) setLoading(false) })
  }, [begin, client, record, fieldId, scope])
  const view = loaded?.owner === scope ? loaded.view : undefined
  const error = failure?.owner === scope ? failure.error : undefined
  return <section aria-label="当前字段的原始来源">
    {loading ? <p role="status">正在读取当前记录对应的原始来源…</p> : null}
    {error === undefined ? null : <><ProjectNotice error={error} /><button className="project-source-button" type="button" onClick={() => { void reload() }}>重新读取当前记录</button></>}
    {view === undefined ? null : <><h3>原文件中的实际来源</h3><SourceFragmentContent fragment={view} /><p className="project-source-note">已核对当前记录修订、已确认映射与原始来源定位。</p></>}
  </section>
}
