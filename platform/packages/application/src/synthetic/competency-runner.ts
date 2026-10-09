import { createHash } from 'node:crypto'
import { canonicalDecimalString } from '@ontology/core'
import { CompetencyQuestionError, assertCompetencyQuestionSet, isToolContext } from '@ontology/contracts'
import type {
  ApprovedCompetencyQuestionReader, CompetencyExecutionPort, CompetencyExecutionRequest,
  CompetencyExpectation, CompetencyQuestion, CompetencyQuestionBoundary, CompetencyQuestionResult,
  CompetencyRunReport, CompetencySourceLocation, CompetencySourceReader, ScopeRef, ToolContext, VersionRef,
  CompetencyValidationTarget,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

const MAX_SOURCE_BYTES = 8_388_608
const MAX_TOTAL_SOURCE_BYTES = 33_554_432

export interface CompetencyRunnerDependencies {
  readonly questions: ApprovedCompetencyQuestionReader
  readonly boundary: CompetencyQuestionBoundary
  readonly sources: CompetencySourceReader
  readonly execution: CompetencyExecutionPort
  readonly validateActual: (value: unknown) => value is CompetencyExpectation
}

function sameRef(a: VersionRef, b: VersionRef): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest }
function sourceKey(ref: VersionRef): string { return `${ref.id}@${ref.version}#${ref.digest}` }
function locationKey(location: CompetencySourceLocation): string { return canonicalJson(location) }
function byteDigest(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

export function competencyExecutionRequest(questionSetRef: VersionRef, question: CompetencyQuestion, validationTarget?: CompetencyValidationTarget): CompetencyExecutionRequest {
  const { questionId, definitionRef, ruleRefs, input, intent, requiredCapabilities, requiredSources } = question
  const body = { questionId, definitionRef, ruleRefs, input, intent, requiredCapabilities, requiredSources, ...(validationTarget === undefined ? {} : { validationTarget }) }
  return { questionSetRef, ...body, inputDigest: sha256DigestOf(canonicalJson(body)) }
}

function matches(expected: CompetencyExpectation, actual: CompetencyExpectation): boolean {
  if (expected.kind !== actual.kind) return false
  if (expected.kind === 'unknown') return true
  if (expected.kind !== 'value' || actual.kind !== 'value') return canonicalJson(expected) === canonicalJson(actual)
  const left = expected.value, right = actual.value
  if (typeof left !== 'object' || typeof right !== 'object') return left === right
  // Units/currencies are separate axes. Declared strings are never treated as numbers.
  if (('unit' in left ? left.unit : undefined) !== ('unit' in right ? right.unit : undefined) ||
      ('currency' in left ? left.currency : undefined) !== ('currency' in right ? right.currency : undefined)) return false
  return canonicalDecimalString(left.amount) === canonicalDecimalString(right.amount)
}

/** Compare independent gold only after the real pipeline and the original source reads. */
export class CompetencyRunner {
  readonly #deps: CompetencyRunnerDependencies
  constructor(dependencies: CompetencyRunnerDependencies) { this.#deps = dependencies }

  async run(ref: VersionRef, ctx: ToolContext, signal: AbortSignal, validationTarget?: CompetencyValidationTarget): Promise<CompetencyRunReport> {
    try { return await this.#run(ref, ctx, signal, validationTarget) } catch (cause) {
      if (signal.aborted) throw new CompetencyQuestionError('CANCELLED', 'competency execution was cancelled', { cause })
      throw cause
    }
  }

  async #run(ref: VersionRef, ctx: ToolContext, signal: AbortSignal, validationTarget?: CompetencyValidationTarget): Promise<CompetencyRunReport> {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'competency execution requires a trusted scope')
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const abort = () => { if (signal.aborted) throw new CompetencyQuestionError('CANCELLED', 'competency execution was cancelled') }
    abort()
    const set = await this.#deps.questions.readApproved(scope, ref, ctx)
    if (set === undefined) throw new CompetencyQuestionError('NOT_APPROVED', 'the exact competency declaration is not approved')
    assertCompetencyQuestionSet(set, this.#deps.boundary, ref)
    for (const question of set.body.questions) if (question.input.scopeRef.tenantId !== scope.tenantId || question.input.scopeRef.spaceId !== scope.spaceId) {
      throw new CompetencyQuestionError('SCOPE_MISMATCH', 'synthetic inputs must belong to the exact authorized scope')
    }
    const originals = new Map<string, Uint8Array>()
    let totalBytes = 0
    for (const sourceRef of set.body.sourceRefs) {
      abort()
      const bytes = await this.#deps.sources.readSource(scope, sourceRef, ctx, signal)
      if (bytes === undefined) continue
      totalBytes += bytes.byteLength
      if (bytes.byteLength > MAX_SOURCE_BYTES || totalBytes > MAX_TOTAL_SOURCE_BYTES) throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency original sources exceed the bounded read budget')
      if (byteDigest(bytes) !== sourceRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency original source bytes differ from the declared version')
      originals.set(sourceKey(sourceRef), bytes)
    }
    const results: CompetencyQuestionResult[] = []
    for (const question of set.body.questions) {
      abort()
      const request = structuredClone(competencyExecutionRequest(ref, question, validationTarget))
      const checkedSources = question.requiredSources.filter((location) => {
        const bytes = originals.get(sourceKey(location.sourceRef))
        return bytes !== undefined && location.endOffset <= bytes.byteLength && byteDigest(bytes.subarray(location.startOffset, location.endOffset)) === location.quoteDigest
      })
      const common = { questionId: question.questionId, question: question.question, taskKind: question.taskKind,
        definitionRef: question.definitionRef, ruleRefs: question.ruleRefs, requiredCapabilities: question.requiredCapabilities,
        requiredSources: question.requiredSources, inputDigest: request.inputDigest, expected: question.expected }
      if (checkedSources.length !== question.requiredSources.length) {
        results.push({ ...common, status: 'not_yet_executable', reason: 'original source or required quote is unavailable',
          sourceCoverage: { required: question.requiredSources.length, verified: checkedSources.length, complete: false }, artifactRefs: [] })
        continue
      }
      const execution = await this.#deps.execution.execute(request, ctx, signal)
      abort()
      if (execution.status === 'not_yet_executable') {
        results.push({ ...common, status: 'not_yet_executable', reason: execution.reason,
          sourceCoverage: { required: question.requiredSources.length, verified: 0, complete: false }, artifactRefs: [] })
        continue
      }
      if (canonicalJson(request) !== canonicalJson(competencyExecutionRequest(ref, question, validationTarget)) ||
          !this.#deps.validateActual(execution.actual) || execution.inputDigest !== request.inputDigest ||
          (validationTarget !== undefined && execution.validationTargetDigest !== sha256DigestOf(canonicalJson(validationTarget))) ||
          !sameRef(execution.definitionRef, question.definitionRef) || canonicalJson(execution.ruleRefs) !== canonicalJson(question.ruleRefs)) {
        throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency execution did not preserve the exact input, definition and rule pins')
      }
      const actualSources = new Set(execution.sources.map(locationKey))
      const verified = checkedSources.filter((location) => actualSources.has(locationKey(location))).length
      const complete = verified === question.requiredSources.length
      const passed = complete && execution.artifactRefs.length > 0 && matches(question.expected, execution.actual)
      results.push({ ...common, actual: execution.actual, status: passed ? 'passed' : 'failed',
        ...(passed ? {} : { reason: complete ? 'actual result does not match independent gold or has no execution artifact' : 'execution evidence does not cover every required original source' }),
        sourceCoverage: { required: question.requiredSources.length, verified, complete }, artifactRefs: execution.artifactRefs })
    }
    // Permission/review changes during execution cannot authorize a late validation report.
    for (const sourceRef of set.body.sourceRefs) {
      if (!originals.has(sourceKey(sourceRef))) continue
      abort()
      const current = await this.#deps.sources.readSource(scope, sourceRef, ctx, signal)
      if (current === undefined || current.byteLength > MAX_SOURCE_BYTES || byteDigest(current) !== sourceRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency original source became unavailable during execution')
    }
    const approved = await this.#deps.questions.readApproved(scope, ref, ctx)
    abort()
    if (approved === undefined || canonicalJson(approved) !== canonicalJson(set)) throw new CompetencyQuestionError('NOT_APPROVED', 'competency approval changed during execution')
    const body = { ...(validationTarget === undefined ? {} : { validationTarget }), questionSetRef: ref, dataMode: 'synthetic' as const, definitionRefs: set.body.definitionRefs,
      ruleRefs: set.body.ruleRefs, sourceRefs: set.body.sourceRefs, results, passed: results.length > 0 && results.every((result) => result.status === 'passed'),
      externalAcceptance: { customerQuote: 'unverified' as const, liveModelQuality: 'unverified' as const } }
    return { ...body, contentDigest: sha256DigestOf(canonicalJson(body)) }
  }
}
