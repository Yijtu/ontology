import type { ReactNode } from 'react'

const CONDITION: Readonly<Record<string, string>> = {
  true: '条件成立',
  false: '条件不成立',
  unknown: '条件未知',
  conflict: '条件冲突',
}
const APPLICABILITY: Readonly<Record<string, string>> = {
  applicable: '适用',
  not_applicable: '不适用',
  unknown: '无法确定适用性',
  conflict: '适用性冲突',
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Decimal strings are displayed verbatim. Formatting never passes through Number. */
export function VerifiedCell({
  value,
  valueType,
}: {
  readonly value: unknown
  readonly valueType?: string
}): ReactNode {
  if (value === null || value === undefined)
    return <span className="project-value project-value--missing">未提供</span>
  if (valueType === 'rule_judgement' && typeof value === 'string')
    return (
      <span className={`project-state project-state--${value}`}>
        {CONDITION[value] ?? APPLICABILITY[value] ?? value}
      </span>
    )
  if (typeof value === 'string')
    return (
      <span className={valueType === 'decimal' ? 'project-value project-value--number' : 'project-value'}>
        {value}
      </span>
    )
  if (typeof value === 'boolean') return <span className="project-value">{value ? '是' : '否'}</span>
  if (typeof value === 'number')
    return <span className="project-value project-value--number">{String(value)}</span>
  if (record(value)) {
    if (
      value['kind'] === 'quantity' &&
      typeof value['value'] === 'string' &&
      typeof value['unitCode'] === 'string'
    )
      return (
        <span className="project-value project-value--number">
          {value['value']}
          <span className="project-value__unit"> {value['unitCode']}</span>
        </span>
      )
    if (
      value['kind'] === 'scalar' &&
      (value['value'] === null || ['string', 'number', 'boolean'].includes(typeof value['value']))
    )
      return <VerifiedCell value={value['value']} {...(valueType === undefined ? {} : { valueType })} />
    if (typeof value['amount'] === 'string') {
      const axis =
        typeof value['unit'] === 'string'
          ? value['unit']
          : typeof value['currency'] === 'string'
            ? value['currency']
            : undefined
      if (axis !== undefined || value['kind'] === 'scalar_decimal')
        return (
          <span className="project-value project-value--number">
            {value['amount']}
            {axis === undefined ? null : <span className="project-value__unit"> {axis}</span>}
          </span>
        )
    }
    if (typeof value['conditionState'] === 'string')
      return (
        <span className="project-rule-state">
          <span>{CONDITION[value['conditionState']] ?? '条件状态无法识别'}</span>
          {typeof value['applicability'] === 'string' ? (
            <small>{APPLICABILITY[value['applicability']] ?? '适用性无法识别'}</small>
          ) : null}
        </span>
      )
    if (typeof value['displayName'] === 'string') return <span>{value['displayName']}</span>
    if (valueType === 'document_quote' && typeof value['quote'] === 'string')
      return <span>{value['quote']}</span>
    if (valueType === 'entity_ref' && typeof value['id'] === 'string')
      return (
        <span>
          实体引用
          <details className="project-audit">
            <summary>实体标识</summary>
            <code>{value['id']}</code>
          </details>
        </span>
      )
    if (
      valueType === 'relation_ref' &&
      typeof value['type'] === 'string' &&
      record(value['from']) &&
      record(value['to'])
    )
      return (
        <span>
          关联关系
          <details className="project-audit">
            <summary>关系端点</summary>
            <p>{value['type']}</p>
            <p>
              {String(value['from']['id'])} → {String(value['to']['id'])}
            </p>
          </details>
        </span>
      )
  }
  return <span className="project-value project-value--missing">此值格式暂不可展示</span>
}

export function formatLocator(value: unknown): string {
  if (!record(value)) return '定位未提供'
  if (value['kind'] === 'table_cell') {
    if (
      typeof value['row'] !== 'number' ||
      !Number.isSafeInteger(value['row']) ||
      value['row'] < 1 ||
      typeof value['column'] !== 'number' ||
      !Number.isSafeInteger(value['column']) ||
      value['column'] < 1
    )
      return '单元格定位不完整'
    const sheet = typeof value['sheetName'] === 'string' ? `${value['sheetName']} · ` : ''
    return (
      sheet +
      (typeof value['address'] === 'string'
        ? value['address']
        : `第 ${String(value['row'])} 行，第 ${String(value['column'])} 列`)
    )
  }
  if (value['kind'] === 'table_row')
    return `${typeof value['sheetName'] === 'string' ? `${value['sheetName']} · ` : ''}第 ${String(value['row'])} 行，列 ${String(value['columnFrom'])}–${String(value['columnTo'])}`
  if (value['kind'] === 'json_pointer') return `JSON 位置 ${String(value['pointer'] ?? '')}`
  if (value['kind'] === 'page') return `第 ${String(value['page'])} 页`
  if (value['kind'] === 'offset') return '文档中的已保存文本范围'
  if (value['kind'] === 'approximate_locator') return '近似位置'
  return '已保存的来源定位'
}
