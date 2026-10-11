import { Button } from './ui'
import './FunctionGuide.css'

export interface FunctionGuideProps {
  readonly view: string
  readonly onNavigate?: (view: string) => void
  readonly onConfigureModel?: () => void
}

interface GuideCopy {
  readonly purpose: string
  readonly before: string
  readonly outcome: string
  readonly steps: readonly string[]
  readonly next?: { readonly label: string; readonly view: string }
}

const GUIDE_COPY: Readonly<Record<string, GuideCopy>> = {
  start: {
    purpose: '从当前场景进入本体建模、项目数据或业务任务。',
    before: '先确认页面顶部的场景和访问模式；可见功能取决于当前授权。',
    outcome: '选定下一步工作入口；此页不会自行导入、审核或发布数据。',
    steps: ['从“本体建模”建立并审核语义版本。', '从“项目实践”整理实际业务数据。', '需要提问时，进入业务问答并查看当前项目的可用任务。'],
  },
  ontology: {
    purpose: '建立业务范围、接入原始资料，并形成待审核的定义与规则。',
    before: '准备业务目标和原始资料；确认资料适用于当前工作区范围。',
    outcome: '得到带版本和来源记录的候选。上传或生成不会自动批准或发布。',
    steps: ['创建或选择工作区。', '上传资料并确认实际来源片段。', '生成或编辑候选，再到“定义与规则”审核当前内容。'],
    next: { label: '查看定义与规则', view: 'definitions' },
  },
  projects: {
    purpose: '按已发布的行业版本创建项目，把原始列映射为项目字段。',
    before: '选择实际发布的版本，并准备结构清晰的项目资料。',
    outcome: '得到有来源映射的项目记录；导入、映射和字段确认本身不等于正式事实发布。',
    steps: ['创建项目并导入资料。', '预览列映射，确认后绑定记录。', '到“实例审核”确认字段和身份，再审核并发布事实。'],
    next: { label: '查看实例审核', view: 'instances' },
  },
  definitions: {
    purpose: '审核对象、属性、关系与规则候选的当前不可变内容。',
    before: '选择正确工作区，核对来源确认、内容摘要和修订版本。',
    outcome: '得到明确批准或拒绝的候选；定义审核与项目实例审核是不同流程。',
    steps: ['逐项核对候选和原始依据。', '批准或拒绝当前候选内容。', '需要形成可选项目版本时，继续到行业包验证与发布。'],
    next: { label: '查看行业包', view: 'packages' },
  },
  instances: {
    purpose: '确认项目记录的字段值、原始单元格和实体身份。',
    before: '先完成资料映射和记录绑定；核对每个字段对应的原始值。',
    outcome: '得到带人工确认和身份决策的记录；这不同于语义候选审核，正式事实仍需单独发布。',
    steps: ['查看字段原值及来源位置。', '逐字段确认或处理冲突。', '选择或创建正确身份，再按页面提供的流程发布记录。'],
  },
  packages: {
    purpose: '校验并发布由审核内容组成的不可变行业包版本。',
    before: '确认定义、规则、题集和来源审核均指向当前工作区修订。',
    outcome: '得到可供项目选择的已发布版本；发布包不代表任何项目数据已成为正式事实。',
    steps: ['选择当前已审核的候选与题集。', '运行实际验证并查看全部问题。', '满足发布门槛后发布新版本，并按页面配置项目。'],
    next: { label: '查看项目数据', view: 'projects' },
  },
  business: {
    purpose: '运行当前项目目录中已注册的业务任务。',
    before: '选择项目，并确认该任务所需的正式事实和就绪状态已满足。',
    outcome: '得到该任务实际支持的结果与依据；数据缺口、冲突和未知状态会保留，不会自动补成结论。',
    steps: ['选择项目目录中标为可用的任务。', '按任务实际参数输入对象和条件。', '查看结果状态与来源；遇到缺口时先补齐正式数据。'],
    next: { label: '打开业务问答', view: 'query' },
  },
  workbench: {
    purpose: '查看和维护当前运行场景的高级组件与能力配置。',
    before: '确认你有该部署配置的操作权限；这里的设置按场景和版本生效。',
    outcome: '看到实际解析出的组件和可用能力；配置成功不代表具体业务数据已就绪。',
    steps: ['检查当前配置和能力缺口。', '只调整当前任务需要的组件。', '发布或启用新配置后，再回到对应业务页面核验实际可用性。'],
    next: { label: '打开模型设置', view: 'models' },
  },
  query: {
    purpose: '在当前场景能力与项目正式数据范围内提出问题。',
    before: '选好项目，并以任务目录显示的可用能力为准；上传、映射或待审核数据不能替代已发布事实。',
    outcome: '得到可核验答案，或明确的缺口、冲突、失败与取消状态；具体支持范围由任务目录和就绪状态决定。',
    steps: ['选择项目并查看实际可用任务。', '描述问题或使用页面提供的注册任务入口。', '核对最终状态与原始依据，不把未核验草稿当答案。'],
    next: { label: '查看项目任务', view: 'business' },
  },
  jobs: {
    purpose: '导入文件并查看原文、解析结果和处理状态。',
    before: '选择正确场景，并确认资料属于允许的来源范围。',
    outcome: '得到原始文件版本及解析状态；导入或解析成功不等于候选已审核或事实已发布。',
    steps: ['提交资料并查看导入任务。', '检查解析完整度和错误行。', '继续完成定义审核或项目映射，不跳过后续人工门槛。'],
    next: { label: '查看候选审核', view: 'review' },
  },
  review: {
    purpose: '审核语义候选、查看其版本和来源，并按权限发布语义事实。',
    before: '核对候选当前内容、审核意见、来源和所属项目修订。',
    outcome: '得到明确的候选审核与语义发布记录；这不等同于项目实例的字段和身份审核。',
    steps: ['选择实际候选并检查内容摘要。', '批准或拒绝当前修订。', '只对满足发布门槛的内容执行语义发布；发布后仍须满足项目任务就绪要求。'],
  },
  evidence: {
    purpose: '回看答案所引用的来源片段、原始单元格和历史版本。',
    before: '从已发布答案或历史记录打开对应来源，保持项目和版本范围一致。',
    outcome: '查看实际引用内容与位置；来源缺失或版本不匹配时应保留该状态。',
    steps: ['从答案进入来源详情。', '核对原文、单元格位置和来源版本。', '需要时查看审核、发布或项目修订历史。'],
  },
  models: {
    purpose: '配置当前部署允许使用的文本生成与智能路由能力。',
    before: '准备当前部署要求的模型服务信息，并确认你拥有配置权限。',
    outcome: '显示当前场景实际可用的模型能力；模型配置不会替代项目数据、审核、发布或任务就绪门槛。',
    steps: ['查看当前模型能力状态。', '按窗口提示配置并验证所需能力。', '返回业务页面，以实际目录和运行状态确认是否可用。'],
  },
}

const FALLBACK_GUIDE: GuideCopy = {
  purpose: '这是当前部署提供的扩展功能页面。',
  before: '先查看当前页面显示的范围、状态和所需输入。',
  outcome: '以页面实际返回的状态和版本为准。',
  steps: ['检查当前可用操作。', '完成页面要求的输入与确认。', '遇到缺口或失败时，按显示的原因处理。'],
}

export function FunctionGuide({ view, onNavigate, onConfigureModel }: FunctionGuideProps) {
  const guide = GUIDE_COPY[view] ?? FALLBACK_GUIDE
  const next = guide.next
  const showModelSettings = view !== 'start' && view !== 'query' && view !== 'models'
  const canNavigate = next !== undefined && onNavigate !== undefined
  const canConfigureModel = onConfigureModel !== undefined && showModelSettings

  return (
    <section className="function-guide" data-testid="function-guide" data-view={view} aria-labelledby="function-guide-title">
      <div className="function-guide__intro">
        <h3 id="function-guide-title">本页说明</h3>
        <p><strong>用途</strong> {guide.purpose}</p>
      </div>
      <div className="function-guide__facts">
        <p><strong>开始前</strong> {guide.before}</p>
        <p><strong>完成后</strong> {guide.outcome}</p>
      </div>
      <details className="function-guide__steps">
        <summary>查看操作步骤</summary>
        <ol>{guide.steps.map((step, index) => <li key={`${view}-${index}`}>{step}</li>)}</ol>
      </details>
      {!canNavigate && !canConfigureModel ? null : (
        <div className="function-guide__actions">
          {!canNavigate || next === undefined || onNavigate === undefined ? null : (
            <Button variant="quiet" onClick={() => onNavigate(next.view)}>{next.label}</Button>
          )}
          {!canConfigureModel || onConfigureModel === undefined ? null : (
            <Button variant="quiet" data-testid="function-guide-configure-model" onClick={onConfigureModel}>生成模型设置</Button>
          )}
        </div>
      )}
    </section>
  )
}
