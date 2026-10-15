const RUN: Readonly<Record<string, string>> = {
  created: '已创建',
  preflight: '正在核对输入',
  collecting: '正在收集依据',
  drafting: '正在整理结果',
  verifying: '正在核验',
  published: '结果已发布',
  awaiting_input: '等待补充说明',
  cancelling: '正在取消',
  cancelled: '已取消',
  blocked: '条件未满足',
  failed: '运行失败',
}
const READINESS: Readonly<Record<string, string>> = {
  pending: '待构建',
  building: '正在构建',
  ready: '已就绪',
  stale: '需要更新',
  failed: '构建失败',
  revoked: '已撤回',
  missing: '尚未构建',
}
export const runStatusLabel = (value: string) => RUN[value] ?? '状态无法识别'
export const readinessStatusLabel = (value: string) => READINESS[value] ?? '状态无法识别'
