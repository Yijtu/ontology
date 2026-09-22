import type {
  DependencyGraphView,
  EvidenceDependencyDirection,
  HistoricalAssertionView,
  ObjectHistoryView,
  ProvenanceEvidenceView,
} from '@ontology/contracts'
import { historyFingerprint } from '../api/provenance'
import type { WorkbenchError, WorkbenchPhase } from './workbench'

/**
 * The provenance/history surface reducer (US-017/US-022, FR-19/FR-30).
 *
 * It reuses the same five explicit non-ready phases as the rest of the app, keeps the
 * current vs historical read explicit (`asOf`/`validAt`), and keeps a bounded graph's
 * truncation flag rather than folding it into a plain list. Two invariants matter most:
 *
 *  - **No fabricated reasoning.** The reducer only ever stores the server's
 *    `ProvenanceEvidenceView` / `DependencyGraphView` / `ObjectHistoryView`. It never invents a
 *    chain-of-thought field, and the component renders explicit fields only.
 *  - **A version change invalidates the old comparison, not the history.** When a fresh history
 *    read yields a different assertion-version set, the previously computed comparison is
 *    cleared and a notice is shown; the historical versions stay readable.
 */
export type EvidencePhase = WorkbenchPhase

export interface ComparisonChange {
  readonly field: string
  readonly from: string
  readonly to: string
}

export interface AssertionComparison {
  readonly baseVersion: string
  readonly compareVersion: string
  readonly baseStatementId: string
  readonly compareStatementId: string
  readonly changes: readonly ComparisonChange[]
  readonly identical: boolean
}

export interface EvidenceState {
  readonly phase: EvidencePhase
  /** The evidence the operator asked for; `undefined` before the first request. */
  readonly evidenceId: string | undefined
  readonly evidence: ProvenanceEvidenceView | undefined
  /** The requested system version; present means the view is an explicit historical replay. */
  readonly asOf: string | undefined
  readonly validAt: string | undefined
  readonly direction: EvidenceDependencyDirection
  readonly depth: number
  readonly graph: DependencyGraphView | undefined
  readonly graphPages: number
  readonly graphCursor: string | undefined
  readonly graphError: WorkbenchError | undefined
  readonly historyObjectId: string | undefined
  readonly history: ObjectHistoryView | undefined
  /** Fingerprint of the assertion-version set the comparison was computed against. */
  readonly historyKey: string | undefined
  readonly historyCursor: string | undefined
  readonly historyError: WorkbenchError | undefined
  readonly comparison: AssertionComparison | undefined
  readonly error: WorkbenchError | undefined
  readonly notice: string | undefined
  readonly busy: boolean
}

export type EvidenceEvent =
  | {
      readonly type: 'evidenceLoadStarted'
      readonly evidenceId: string
      readonly asOf?: string
      readonly validAt?: string
    }
  | { readonly type: 'evidenceLoaded'; readonly evidence: ProvenanceEvidenceView }
  | { readonly type: 'setDirection'; readonly direction: EvidenceDependencyDirection }
  | { readonly type: 'setDepth'; readonly depth: number }
  | { readonly type: 'graphLoadStarted' }
  | {
      readonly type: 'graphLoaded'
      readonly graph: DependencyGraphView
      readonly nextCursor: string | undefined
      readonly append: boolean
    }
  | { readonly type: 'graphFailed'; readonly error: WorkbenchError }
  | { readonly type: 'historyLoadStarted'; readonly objectId: string }
  | {
      readonly type: 'historyLoaded'
      readonly view: ObjectHistoryView
      readonly nextCursor: string | undefined
    }
  | { readonly type: 'historyFailed'; readonly error: WorkbenchError }
  | { readonly type: 'compareRequested'; readonly baseVersion: string; readonly compareVersion: string }
  | { readonly type: 'compareCleared' }
  | { readonly type: 'permissionDenied'; readonly error: WorkbenchError }
  | { readonly type: 'notConfigured'; readonly error: WorkbenchError }
  | { readonly type: 'failed'; readonly error: WorkbenchError }
  | { readonly type: 'awaitInput' }
  | { readonly type: 'busy' }
  | { readonly type: 'idle' }
  | { readonly type: 'notice'; readonly message: string }

export function initialEvidenceState(): EvidenceState {
  return {
    phase: 'loading',
    evidenceId: undefined,
    evidence: undefined,
    asOf: undefined,
    validAt: undefined,
    direction: 'outbound',
    depth: 1,
    graph: undefined,
    graphPages: 0,
    graphCursor: undefined,
    graphError: undefined,
    historyObjectId: undefined,
    history: undefined,
    historyKey: undefined,
    historyCursor: undefined,
    historyError: undefined,
    comparison: undefined,
    error: undefined,
    notice: undefined,
    busy: false,
  }
}

const COMPARED_FIELDS = [
  'status',
  'value',
  'unitCode',
  'validFrom',
  'validTo',
  'recordedAt',
  'revisionKind',
  'revisionReason',
] as const

function fieldOf(assertion: HistoricalAssertionView, field: string): string {
  switch (field) {
    case 'value':
      return JSON.stringify(assertion.value)
    case 'status':
      return assertion.status
    case 'unitCode':
      return assertion.unitCode ?? ''
    case 'validFrom':
      return assertion.validFrom ?? ''
    case 'validTo':
      return assertion.validTo ?? ''
    case 'recordedAt':
      return assertion.recordedAt
    case 'revisionKind':
      return assertion.revisionKind ?? ''
    case 'revisionReason':
      return assertion.revisionReason ?? ''
    default:
      return ''
  }
}

function compareAssertions(
  view: ObjectHistoryView,
  baseVersion: string,
  compareVersion: string,
): AssertionComparison | undefined {
  const base = view.assertions.find((assertion) => assertion.version === baseVersion)
  const compare = view.assertions.find((assertion) => assertion.version === compareVersion)
  if (base === undefined || compare === undefined) return undefined
  const changes: ComparisonChange[] = []
  for (const field of COMPARED_FIELDS) {
    const from = fieldOf(base, field)
    const to = fieldOf(compare, field)
    if (from !== to) changes.push({ field, from, to })
  }
  return {
    baseVersion,
    compareVersion,
    baseStatementId: base.statementId,
    compareStatementId: compare.statementId,
    changes,
    identical: changes.length === 0,
  }
}

function mergeGraph(
  current: DependencyGraphView | undefined,
  next: DependencyGraphView,
  append: boolean,
): DependencyGraphView {
  if (!append || current === undefined) return next
  const nodes = [...current.nodes]
  const seenNodes = new Set(nodes.map((node) => node.evidenceId))
  for (const node of next.nodes) {
    if (!seenNodes.has(node.evidenceId)) {
      nodes.push(node)
      seenNodes.add(node.evidenceId)
    }
  }
  const edges = [...current.edges]
  const seenEdges = new Set(
    edges.map((edge) => `${edge.fromEvidenceId}|${edge.toEvidenceId}|${edge.relation}|${edge.origin}`),
  )
  for (const edge of next.edges) {
    const key = `${edge.fromEvidenceId}|${edge.toEvidenceId}|${edge.relation}|${edge.origin}`
    if (!seenEdges.has(key)) {
      edges.push(edge)
      seenEdges.add(key)
    }
  }
  return { ...next, nodes, edges }
}

export function evidenceReducer(state: EvidenceState, event: EvidenceEvent): EvidenceState {
  switch (event.type) {
    case 'evidenceLoadStarted':
      return {
        ...state,
        phase: 'loading',
        busy: true,
        error: undefined,
        notice: undefined,
        evidenceId: event.evidenceId,
        asOf: event.asOf,
        validAt: event.validAt,
        // A new evidence item invalidates the previous item's graph and any read state.
        evidence: undefined,
        graph: undefined,
        graphPages: 0,
        graphCursor: undefined,
        graphError: undefined,
      }
    case 'evidenceLoaded':
      return {
        ...state,
        phase: 'ready',
        evidence: event.evidence,
        busy: false,
        error: undefined,
        graph: undefined,
        graphPages: 0,
        graphCursor: undefined,
        graphError: undefined,
      }
    case 'setDirection':
      return { ...state, direction: event.direction }
    case 'setDepth':
      return { ...state, depth: Number.isFinite(event.depth) ? Math.max(0, Math.floor(event.depth)) : state.depth }
    case 'graphLoadStarted':
      return { ...state, busy: true, graphError: undefined }
    case 'graphLoaded':
      return {
        ...state,
        graph: mergeGraph(state.graph, event.graph, event.append),
        graphPages: state.graphPages + 1,
        graphCursor: event.nextCursor,
        graphError: undefined,
        busy: false,
      }
    case 'graphFailed':
      // The graph failed but the provenance view stands; the error is explicit, not hidden.
      return { ...state, graphError: event.error, busy: false }
    case 'historyLoadStarted':
      return {
        ...state,
        busy: true,
        historyObjectId: event.objectId,
        historyError: undefined,
        notice: undefined,
      }
    case 'historyLoaded': {
      const nextKey = historyFingerprint(event.view)
      const changed =
        state.history !== undefined && state.historyKey !== undefined && state.historyKey !== nextKey
      return {
        ...state,
        phase: 'ready',
        history: event.view,
        historyKey: nextKey,
        historyCursor: event.nextCursor,
        historyError: undefined,
        // A changed version set invalidates the comparison; the history itself stays readable.
        comparison: changed ? undefined : state.comparison,
        notice: changed
          ? '检测到版本变化：已清除旧比较结果；历史版本仍可回看。'
          : state.notice,
        busy: false,
      }
    }
    case 'historyFailed':
      return {
        ...state,
        history: undefined,
        historyKey: undefined,
        historyCursor: undefined,
        comparison: undefined,
        historyError: event.error,
        busy: false,
      }
    case 'compareRequested': {
      const history = state.history
      if (history === undefined) return state
      const comparison = compareAssertions(history, event.baseVersion, event.compareVersion)
      if (comparison === undefined) {
        return { ...state, notice: '所选版本不在当前历史中，无法比较。', comparison: undefined }
      }
      return { ...state, comparison, notice: undefined }
    }
    case 'compareCleared':
      return { ...state, comparison: undefined }
    case 'permissionDenied':
      // A permission failure must not leave the previously loaded original text or another
      // scope's objects on screen.
      return {
        ...initialEvidenceState(),
        phase: 'permission_denied',
        evidenceId: state.evidenceId,
        direction: state.direction,
        depth: state.depth,
        error: event.error,
      }
    case 'notConfigured':
      return { ...state, phase: 'not_configured', error: event.error, busy: false }
    case 'failed':
      return {
        ...state,
        phase: 'failure',
        evidence: undefined,
        graph: undefined,
        graphPages: 0,
        graphCursor: undefined,
        graphError: undefined,
        error: event.error,
        busy: false,
      }
    case 'awaitInput':
      return { ...state, phase: 'empty', busy: false }
    case 'busy':
      return { ...state, busy: true }
    case 'idle':
      return { ...state, busy: false }
    case 'notice':
      return { ...state, notice: event.message, busy: false }
  }
}
