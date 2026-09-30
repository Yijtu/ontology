import type { CaseEvaluation } from './scoring'

/**
 * The real-model readiness report (V03-046, A.US-016.AC-05).
 *
 * The report keeps two things strictly apart:
 *   - `controlled`: the outcome of replaying the fixed set against controlled/loopback
 *     transcripts. It can only ever claim `proves: 'mechanism_only'` — the harness detects a
 *     wrong value, an omission and a fabrication. It is NOT evidence of model quality.
 *   - `realModel`: the outcome of a real authorized endpoint. When the endpoint or the
 *     evaluation budget is unavailable it is `not_verified` with a reason and empty defect
 *     lists; the builder never copies a controlled result into it.
 *
 * Secrets are never part of a report: only a model/API version, the reference-set digest and
 * review classifications are recorded.
 */

export interface CandidateDefect {
  readonly caseId: string
  readonly kind: 'error' | 'omission' | 'unexpected'
  readonly detail: string
}

export interface DisambiguationNote {
  readonly caseId: string
  readonly detail: string
}

export interface HumanCorrection {
  readonly caseId: string
  readonly detail: string
}

export interface ControlledVerification {
  readonly mode: 'controlled'
  /** What a controlled run can prove; never a quality claim. */
  readonly proves: 'mechanism_only'
  readonly setDigest: string
  readonly cases: readonly CaseEvaluation[]
  readonly summary: {
    readonly cases: number
    readonly passed: number
    readonly failed: number
  }
  readonly candidateErrors: readonly CandidateDefect[]
  readonly omissions: readonly CandidateDefect[]
  readonly disambiguation: readonly DisambiguationNote[]
  readonly humanCorrections: readonly HumanCorrection[]
}

export type RealModelQualityStatus = 'verified' | 'not_verified'

export interface RealModelReadiness {
  readonly status: RealModelQualityStatus
  readonly reason: string
  readonly apiVersion: string
  readonly modelVersion: string
  readonly referenceSetDigest: string
  readonly candidateErrors: readonly CandidateDefect[]
  readonly omissions: readonly CandidateDefect[]
  readonly disambiguation: readonly DisambiguationNote[]
  readonly humanCorrections: readonly HumanCorrection[]
  /** Human-readable proof of the real run (endpoint-classified outcomes); never a secret. */
  readonly evidence: readonly string[]
}

export interface ModelReadinessReport {
  readonly schemaVersion: 'ontology.model-readiness@1'
  readonly generatedAt: string
  readonly evalSetDigest: string
  readonly controlled: ControlledVerification
  readonly realModel: RealModelReadiness
  readonly notes: readonly string[]
}

/** A real-model run an operator supplies only after reaching an authorized endpoint. */
export interface RealModelRun {
  readonly apiVersion: string
  readonly modelVersion: string
  readonly referenceSetDigest: string
  readonly cases: readonly CaseEvaluation[]
  readonly evidence: readonly string[]
}

export interface BuildReadinessReportOptions {
  readonly setDigest: string
  readonly controlled: ControlledVerification
  readonly realModel?: RealModelRun | undefined
  readonly now?: () => string
}

interface DefectBundle {
  readonly candidateErrors: readonly CandidateDefect[]
  readonly omissions: readonly CandidateDefect[]
  readonly disambiguation: readonly DisambiguationNote[]
  readonly humanCorrections: readonly HumanCorrection[]
}

function collectDefects(cases: readonly CaseEvaluation[]): DefectBundle {
  const candidateErrors: CandidateDefect[] = []
  const omissions: CandidateDefect[] = []
  const disambiguation: DisambiguationNote[] = []
  const humanCorrections: HumanCorrection[] = []
  for (const evaluation of cases) {
    for (const error of evaluation.errors) {
      candidateErrors.push({
        caseId: evaluation.caseId,
        kind: 'error',
        detail: `${error.key}.${error.field}: expected ${error.expected}, observed ${error.observed}`,
      })
    }
    for (const key of evaluation.missing) {
      omissions.push({ caseId: evaluation.caseId, kind: 'omission', detail: key })
    }
    for (const key of evaluation.unexpected) {
      candidateErrors.push({ caseId: evaluation.caseId, kind: 'unexpected', detail: key })
    }
    for (const detail of evaluation.disambiguation) {
      disambiguation.push({ caseId: evaluation.caseId, detail })
    }
    for (const detail of evaluation.requiredCorrections) {
      humanCorrections.push({ caseId: evaluation.caseId, detail })
    }
  }
  return { candidateErrors, omissions, disambiguation, humanCorrections }
}

/** Summarise a controlled run; `passed` compares each case to its authored expectation. */
export function buildControlledVerification(
  setDigest: string,
  cases: readonly CaseEvaluation[],
  passed: number,
): ControlledVerification {
  return {
    mode: 'controlled',
    proves: 'mechanism_only',
    setDigest,
    cases,
    summary: { cases: cases.length, passed, failed: cases.length - passed },
    ...collectDefects(cases),
  }
}

function notVerifiedReadiness(referenceSetDigest: string): RealModelReadiness {
  return {
    status: 'not_verified',
    reason:
      'no authorized company endpoint and evaluation budget were available; the fixed set was exercised only against a controlled/loopback transcript, which proves the mechanism and never real extraction quality',
    apiVersion: 'not_configured',
    modelVersion: 'not_configured',
    referenceSetDigest,
    candidateErrors: [],
    omissions: [],
    disambiguation: [],
    humanCorrections: [],
    evidence: [],
  }
}

function verifiedReadiness(run: RealModelRun): RealModelReadiness {
  return {
    status: 'verified',
    reason: 'a real authorized endpoint was reached and the fixed set was evaluated against it',
    apiVersion: run.apiVersion,
    modelVersion: run.modelVersion,
    referenceSetDigest: run.referenceSetDigest,
    ...collectDefects(run.cases),
    evidence: [...run.evidence],
  }
}

const READINESS_NOTES: readonly string[] = [
  'controlled-model verification and real-model quality are reported separately and are never conflated',
  'no extraction-quality claim is derived from controlled outputs; the controlled run only proves the harness mechanism',
  'a real result is recorded only from an authorized endpoint; a missing endpoint or budget is recorded as not_verified',
  'the report stores no secrets and no customer raw material, only model/api versions and review classifications',
]

export function buildReadinessReport(options: BuildReadinessReportOptions): ModelReadinessReport {
  const now = options.now ?? (() => new Date().toISOString())
  const realModel =
    options.realModel === undefined ? notVerifiedReadiness(options.setDigest) : verifiedReadiness(options.realModel)
  const report: ModelReadinessReport = {
    schemaVersion: 'ontology.model-readiness@1',
    generatedAt: now(),
    evalSetDigest: options.setDigest,
    controlled: options.controlled,
    realModel,
    notes: READINESS_NOTES,
  }
  assertReadinessHonest(report)
  return report
}

/**
 * Refuse a dishonest report: a `not_verified` real section must carry no result, a `verified`
 * one must carry evidence, and no real section may cite a different reference set. This is a
 * guard against a controlled result being promoted into the real-model section.
 */
export function assertReadinessHonest(report: ModelReadinessReport): void {
  if (report.realModel.referenceSetDigest !== report.evalSetDigest) {
    throw new Error('the real-model reference set digest must equal the evaluation-set digest')
  }
  const hasRealResult =
    report.realModel.candidateErrors.length > 0 ||
    report.realModel.omissions.length > 0 ||
    report.realModel.disambiguation.length > 0 ||
    report.realModel.humanCorrections.length > 0 ||
    report.realModel.evidence.length > 0
  if (report.realModel.status === 'not_verified' && hasRealResult) {
    throw new Error('a not_verified real-model section must not carry any real result')
  }
  if (report.realModel.status === 'verified' && report.realModel.evidence.length === 0) {
    throw new Error('a verified real-model section must carry the evidence of the real run')
  }
}
