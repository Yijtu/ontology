/**
 * The shared "接入结构化数据（文件映射）" boundary notice (design §1.3, node N07).
 *
 * The industry-source entry (`CoreImportPanel`, the ontology `sources` tab) and the
 * project data entry (`ProjectFileImport` + the project mapping step) render the same
 * notice, so a reader sees one intake contract no matter which workbench they started
 * from: this release accepts a fixed file snapshot and is explicitly not a live sync,
 * and the database connector is a planned capability with a stated boundary rather
 * than a form that cannot complete.
 */
export interface StructuredIntakeNoticeProps {
  readonly testId?: string
  readonly className?: string
}

export function StructuredIntakeNotice({
  testId = 'structured-intake-notice',
  className,
}: StructuredIntakeNoticeProps) {
  return (
    <section
      className={className === undefined ? 'structured-intake' : `structured-intake ${className}`}
      data-testid={testId}
      aria-label="结构化数据接入说明"
    >
      <p className="structured-intake__snapshot" data-testid={`${testId}-snapshot`}>
        当前为<b>文件快照接入</b>：每次读取所选文件、工作表与列的固定快照并保留版本，不是实时同步；
        源文件变化需重新接入并生成新修订，历史快照不随之改写。
      </p>
      <details className="structured-intake__database">
        <summary data-testid={`${testId}-database`}>
          数据库连接（规划能力，当前不可用）
        </summary>
        <p data-testid={`${testId}-database-note`}>
          本版本只交付文件映射，不提供数据库连接，也不展示无法完成的连接表单。
        </p>
        <ul>
          <li>只读账号与对象白名单</li>
          <li>快照一致性与增量／删除语义</li>
          <li>凭据托管与轮换</li>
        </ul>
      </details>
    </section>
  )
}

/**
 * The structured-intake stages from the design (§1.3): 待映射 → 映射待确认 → 记录待确认 →
 * 发布/构建中 → 就绪. The stage is derived only from server readback (parsed sources,
 * immutable mapping versions, bound records, readiness projections); it never infers a
 * "ready" state the server has not published.
 */
export type StructuredIntakeStage =
  | 'awaiting_mapping'
  | 'mapping_pending'
  | 'records_pending'
  | 'building'
  | 'ready'

export const STRUCTURED_INTAKE_STAGE_LABEL: Readonly<Record<StructuredIntakeStage, string>> = {
  awaiting_mapping: '待映射',
  mapping_pending: '映射待确认',
  records_pending: '记录待确认',
  building: '发布/构建中',
  ready: '就绪',
}

export interface StructuredIntakeStageInput {
  readonly sourceCount: number
  readonly mappingCount: number
  /** Whether a mapping has been confirmed in this session (server-returned version). */
  readonly mappingConfirmed: boolean
  readonly recordTotal: number
  /** Readiness projections read back from the server; undefined means "not read yet". */
  readonly readiness: {
    readonly blockers: readonly unknown[]
    readonly states: readonly string[]
  } | undefined
}

export function structuredIntakeStage(input: StructuredIntakeStageInput): StructuredIntakeStage {
  if (input.sourceCount === 0) return 'awaiting_mapping'
  const hasMapping = input.mappingConfirmed || input.mappingCount > 0
  if (!hasMapping) return 'mapping_pending'
  if (input.recordTotal === 0) return 'records_pending'
  // A confirmed mapping plus bound records is not "ready" by itself: only the server's
  // readiness projections can say a dataset/index is actually built and usable.
  if (input.readiness === undefined || input.readiness.blockers.length > 0) return 'building'
  return input.readiness.states.every((state) => state === 'ready') ? 'ready' : 'building'
}
