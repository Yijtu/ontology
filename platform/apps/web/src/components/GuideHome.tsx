import type { AppView } from './App'

/**
 * The plain-language landing for the default web app (V03 unified entry). It states the current
 * scenario/classification/mode without overclaiming, walks a first-time user through the numbered
 * recommended path, and links every workbench with a one-line plain description. It only switches
 * the active view; it performs no HTTP work itself.
 */

export interface GuideStep {
  readonly key: string
  readonly label: string
  readonly view: AppView
  readonly description: string
}

export interface GuideCard {
  readonly key: string
  readonly label: string
  readonly view: AppView
  readonly description: string
}

export interface GuideHomeProps {
  readonly scenarioLabel: string
  readonly classificationLabel: string
  readonly operatorEnabled: boolean
  readonly onNavigate: (view: AppView) => void
}

const PATH_STEPS: readonly GuideStep[] = [
  { key: 'import', label: '1. 导入资料', view: 'jobs', description: '把原始记录或文件导入为待审核候选。' },
  { key: 'review', label: '2. 审核候选', view: 'review', description: '逐条确认抽取出的对象、字段与关系。' },
  { key: 'identity', label: '3. 身份确认', view: 'instances', description: '对同一实体的记录做匹配或拆分。' },
  { key: 'publish', label: '4. 发布', view: 'packages', description: '把已审核语义发布为行业包版本。' },
  { key: 'ask', label: '5. 业务问答', view: 'query', description: '用自然语言或注册任务提问并读取已核验答案。' },
  { key: 'evidence', label: '6. 查看证据', view: 'evidence', description: '回到证据与历史，核对答案依据。' },
]

const CARDS: readonly GuideCard[] = [
  { key: 'ontology', label: '本体工作区', view: 'ontology', description: '创建与切换行业本体工作区，管理草稿修订。' },
  { key: 'projects', label: '项目数据', view: 'projects', description: '创建客户项目，导入资料并确认列映射。' },
  { key: 'definitions', label: '定义与规则', view: 'definitions', description: '审核对象、属性、关系定义与规则候选。' },
  { key: 'instances', label: '实例审核', view: 'instances', description: '确认实例字段、处理冲突与实体身份。' },
  { key: 'packages', label: '行业包', view: 'packages', description: '校验、发布、导出并挂载行业包版本。' },
]

export function GuideHome({ scenarioLabel, classificationLabel, operatorEnabled, onNavigate }: GuideHomeProps) {
  return (
    <section className="app__guide" data-testid="guide-home">
      <header className="app__guide-header">
        <h1>开始使用</h1>
        <p className="app__guide-hint">
          按下方推荐路径逐步完成从资料导入到业务问答的闭环；每一步都可以从左侧导航单独进入。
        </p>
      </header>

      <dl className="app__guide-context" data-testid="guide-context">
        <div>
          <dt>当前场景</dt>
          <dd data-testid="guide-scenario">{scenarioLabel}</dd>
        </div>
        <div>
          <dt>数据分类</dt>
          <dd data-testid="guide-classification">{classificationLabel}</dd>
        </div>
        <div>
          <dt>运行模式</dt>
          <dd data-testid="guide-mode">{operatorEnabled ? '本地操作员模式' : '只读业务模式'}</dd>
        </div>
      </dl>

      <p className="app__guide-disclaimer" data-testid="guide-disclaimer" role="note">
        注意：当前部署默认使用合成演示数据，仅用于本地与演示环境，请勿据此做真实业务决策。
      </p>

      <section className="app__guide-path" aria-label="推荐路径">
        <h2>推荐路径</h2>
        <ol>
          {PATH_STEPS.map((step) => (
            <li key={step.key} data-testid="guide-path-step" data-step={step.key}>
              <button type="button" className="app__guide-step" onClick={() => onNavigate(step.view)}>
                {step.label}
              </button>
              <span>{step.description}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="app__guide-cards" aria-label="工作台入口">
        <h2>工作台</h2>
        <ul>
          {CARDS.map((card) => (
            <li key={card.key} data-testid="guide-card" data-card={card.key}>
              <button type="button" data-testid={`guide-card-${card.key}`} onClick={() => onNavigate(card.view)}>
                {card.label}
              </button>
              <p>{card.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  )
}
