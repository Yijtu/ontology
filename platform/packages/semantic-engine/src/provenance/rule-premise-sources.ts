import { createHash } from 'node:crypto'
import { isRecord, isResourceRef } from '@ontology/contracts'
import type { BlobGetAuthorizedRequest, CandidateStore, DocumentParseStore, DocumentSpanReaderPort, EvidenceStorePort, ProjectionSlice, ResourceRef, RuleComputationArtifact, RuleComputationFactRef, RuleProvenanceSpan, RuleStructuredPremiseSourcePort, ScopeRef, ToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { publishedRuleRef } from '../rules'
import { materializedRuleSupportFactGroupsOf } from './materialized-support-reader'

export interface RulePremiseSourceDependencies {
  readonly evidence: Pick<EvidenceStorePort, 'get'>
  readonly artifacts: {
    readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
    getAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<{ readonly integrityVerified: boolean; readonly byteSize: number }>
  }
  readonly candidates: Pick<CandidateStore, 'getCandidate'>
  readonly documentParses: Pick<DocumentParseStore, 'getParse' | 'findParseByDigest'>
  readonly documentSpans: DocumentSpanReaderPort
  readonly structuredSources?: RuleStructuredPremiseSourcePort
}
const equal = (a: unknown, b: unknown): boolean => sha256DigestOf(a) === sha256DigestOf(b)
const digest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

export interface RulePremiseSourceTarget {
  readonly groupId: string
  readonly fact: RuleComputationFactRef
  readonly sourceRef: ResourceRef
}

/** Preserve saved group membership; also locate observations retained on other support axes. */
export function rulePremiseSourceTargetsOf(slice: ProjectionSlice, artifact: RuleComputationArtifact): readonly RulePremiseSourceTarget[] {
  const targets: RulePremiseSourceTarget[] = []
  for (const group of materializedRuleSupportFactGroupsOf(slice, artifact) ?? []) for (const fact of group.factRefs) {
    for (const sourceRef of fact.sourceRefs ?? []) if (sourceRef.kind !== 'evidence') targets.push({ groupId: group.groupId, fact, sourceRef })
  }
  for (const fact of [...artifact.factRefs, ...artifact.applicability.exceptionStates.flatMap((exception) => exception.factRefs)]) {
    for (const sourceRef of fact.sourceRefs ?? []) if (sourceRef.kind !== 'evidence' && !targets.some((target) => target.fact.assertionId === fact.assertionId && equal(target.sourceRef, sourceRef))) {
      targets.push({ groupId: `observed:${fact.assertionId}`, fact, sourceRef })
    }
  }
  return [...new Map(targets.map((target) => [sha256DigestOf({ groupId: target.groupId, assertionId: target.fact.assertionId, sourceRef: target.sourceRef }), target])).values()]
}

/** All actual declaration spans in the fixed dependency closure, including upstream policies. */
export function rulePremisePolicySpans(artifact: RuleComputationArtifact): readonly RuleProvenanceSpan[] {
  const spans = new Map<string, RuleProvenanceSpan>(artifact.sourceSpans.map((span) => [sha256DigestOf(span), span]))
  const declarations = artifact.premiseInput?.declarations ?? []
  const seen = new Set<string>()
  const visit = (ref: { readonly id: string; readonly version: string; readonly digest: string }): void => {
    const key = sha256DigestOf(ref)
    if (seen.has(key)) return
    seen.add(key)
    const declaration = declarations.find((rule) => equal(publishedRuleRef(rule), ref))
    if (declaration === undefined) return
    const walk = (node: typeof declaration.expression): void => {
      for (const span of node.spans) spans.set(sha256DigestOf(span), span)
      if (node.op === 'all' || node.op === 'any') node.operands.forEach(walk)
      if (node.op === 'not') walk(node.operand)
      if (node.op === 'relation' && node.targetCondition !== undefined) walk(node.targetCondition)
    }
    walk(declaration.expression)
    declaration.exceptions.forEach((exception) => walk(exception.condition))
    declaration.dependencyRefs?.forEach((dependency) => visit(dependency.ruleRef))
  }
  visit(artifact.ruleRef)
  return [...spans.values()]
}

async function readArtifact(deps: RulePremiseSourceDependencies, scopeRef: ScopeRef, ref: ResourceRef, ctx: ToolContext): Promise<Uint8Array | undefined> {
  const metadata = await deps.artifacts.getAuthorized({ scopeRef, blobRef: ref }, ctx)
  if (!metadata.integrityVerified || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize > 1_048_576 || metadata.byteSize < 1) return undefined
  const bytes = await deps.artifacts.readAuthorized({ scopeRef, blobRef: ref }, ctx)
  return bytes.byteLength <= 1_048_576 && digest(bytes) === ref.digest ? bytes : undefined
}

async function readBinding(deps: RulePremiseSourceDependencies, scope: ScopeRef, ref: ResourceRef, ctx: ToolContext): Promise<Record<string, unknown> | undefined> {
  const record = await deps.evidence.get(scope, ref.id, ctx)
  if (record === undefined || !equal(record.evidenceRef, ref) || !equal(record.envelope.scopeRef, scope) || record.envelope.kind !== 'document_span' || record.envelope.payloadRef === undefined) return undefined
  const { integrity, ...body } = record.envelope
  if (sha256DigestOf(body) !== integrity.digest || ref.digest !== integrity.digest) return undefined
  const bytes = await readArtifact(deps, scope, record.envelope.payloadRef, ctx)
  if (bytes === undefined) return undefined
  const binding: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(binding) || !isResourceRef(binding['textArtifactRef'])) return undefined
  const text = await readArtifact(deps, scope, binding['textArtifactRef'], ctx)
  if (text === undefined || digest(text) !== record.envelope.resultDigest) return undefined
  return binding
}

/** Read every fact and policy source through its original candidate/parse/span and archive. */
export async function verifyRulePremiseSources(artifact: RuleComputationArtifact, payload: unknown, deps: RulePremiseSourceDependencies, ctx: ToolContext, targets: readonly RulePremiseSourceTarget[]): Promise<boolean> {
  if (!isRecord(payload) || payload['schemaVersion'] !== 'rule-derivation-support-payload@1' || !Array.isArray(payload['premiseRefs']) ||
    payload['premiseRefs'].length > 256 || !payload['premiseRefs'].every(isResourceRef) ||
    !Array.isArray(payload['sourceEvidenceMappings']) || !Array.isArray(payload['policySourceEvidenceMappings'])) return false
  const scope = artifact.scopeRef
  const sourceMappings = payload['sourceEvidenceMappings']
  if (sourceMappings.length !== targets.length || payload['policySourceEvidenceMappings'].length !== rulePremisePolicySpans(artifact).length) return false
  if (!targets.every((target) => sourceMappings.some((mapping: unknown) => isRecord(mapping) && mapping['premiseGroup'] === target.groupId &&
    mapping['assertionId'] === target.fact.assertionId && equal(mapping['sourceRef'], target.sourceRef)))) return false
  const expectedRefs = new Map<string, ResourceRef>()
  const facts = [...artifact.factRefs, ...artifact.applicability.exceptionStates.flatMap((exception) => exception.factRefs)]
  const observed = artifact.premiseInput?.facts ?? []
  for (const fact of facts) {
    const observation = observed.find((row) => row.assertionId === fact.assertionId)
    if (observation === undefined || fact.sourceStatementId === undefined || (fact.sourceRefs?.length ?? 0) === 0) return false
    for (const source of fact.sourceRefs ?? []) {
      if (source.kind === 'evidence') return false // An unlocated generic observation cannot prove an original span.
      const candidate = await deps.candidates.getCandidate(scope, fact.sourceStatementId, ctx)
      if (candidate === undefined || (candidate.kind !== 'entity' && candidate.kind !== 'relation') || !equal(candidate.inputVersion.definitionRef, artifact.definitionRef) ||
        candidate.kind === 'entity' && candidate.objectId !== observation.objectId || candidate.inputVersion.parserVersion !== source.version || candidate.inputVersion.documentVersionRef === undefined) return false
      const fieldIndex = candidate.kind === 'entity' ? candidate.attributes.findIndex((attribute) => attribute.attributeId === observation.attributeId) : -1
      const structured = fieldIndex < 0 ? candidate.sourceSpans.find((span) => span.kind === 'structured' && span.recordId === source.id) : candidate.sourceSpans[fieldIndex]
      const span = structured?.kind === 'structured' ? structured : candidate.sourceSpans.find((row) => row.kind !== 'structured' && row.chunkId === source.id && row.textDigest === source.digest && row.quoteDigest === source.digest)
      if (span === undefined) return false
      const mappings = sourceMappings.filter((row) => isRecord(row) && row['assertionId'] === fact.assertionId && equal(row['sourceRef'], source))
      if (mappings.length === 0) return false
      for (const mapping of mappings) {
        if (!isRecord(mapping) || !isResourceRef(mapping['evidenceRef'])) return false
        if (!targets.some((target) => target.groupId === mapping['premiseGroup'] && target.fact.assertionId === fact.assertionId && equal(target.sourceRef, source))) return false
        const binding = await readBinding(deps, scope, mapping['evidenceRef'], ctx)
        if (span.kind === 'structured') {
          const read = await deps.structuredSources?.read(candidate, span, ctx)
          if (binding === undefined || read === undefined || span.recordId !== source.id || span.rowDigest !== source.digest || !equal(mapping['sourceSpan'], span) ||
            !equal(mapping['documentRef'], read.documentRef) || !equal(mapping['documentVersionRef'], read.documentVersionRef) || mapping['parserVersion'] !== read.parserVersion ||
            mapping['sourceStatementId'] !== fact.sourceStatementId || mapping['logicalAssertionId'] !== fact.logicalAssertionId || binding['schemaVersion'] !== 'rule-source-span-binding@1' ||
            digest(new TextEncoder().encode(read.rowText)) !== source.digest) return false
          const { evidenceRef: omitted, ...expected } = mapping
          void omitted
          const { textArtifactRef: text, schemaVersion: schema, ...actual } = binding
          void text; void schema
          if (!equal(expected, actual)) return false
          expectedRefs.set(sha256DigestOf(mapping['evidenceRef']), mapping['evidenceRef'])
          continue
        }
        const parse = await deps.documentParses.getParse(scope, span.parseId, ctx)
        if (binding === undefined || parse === undefined || !equal(parse.scopeRef, scope) || !equal(parse.documentVersionRef, candidate.inputVersion.documentVersionRef) ||
          !equal(mapping['sourceCoverage'], parse.coverage) ||
          parse.parserVersion !== candidate.inputVersion.parserVersion || !equal(mapping['sourceSpan'], span) || !equal(mapping['documentRef'], parse.originalRef) ||
          !equal(mapping['documentVersionRef'], candidate.inputVersion.documentVersionRef) || mapping['sourceStatementId'] !== fact.sourceStatementId ||
          mapping['logicalAssertionId'] !== fact.logicalAssertionId || binding['schemaVersion'] !== 'rule-source-span-binding@1') return false
        const { evidenceRef: omitted, ...expected } = mapping
        void omitted
        const { textArtifactRef: text, schemaVersion: schema, ...actual } = binding
        void text; void schema
        if (!equal(expected, actual)) return false
        const read = await deps.documentSpans.readSpan({ documentRef: parse.originalRef, locator: span.locator, maxBytes: 128 * 1024 }, ctx)
        if (read.truncated === true || read.textDigest !== source.digest || digest(new TextEncoder().encode(read.text)) !== source.digest || !equal(read.documentRef, parse.originalRef)) return false
        expectedRefs.set(sha256DigestOf(mapping['evidenceRef']), mapping['evidenceRef'])
      }
    }
  }
  for (const span of rulePremisePolicySpans(artifact)) {
    const mappings = payload['policySourceEvidenceMappings'].filter((row) => isRecord(row) && equal(row['span'], span))
    if (mappings.length !== 1) return false
    const mapping = mappings[0]
    if (!isRecord(mapping) || !isResourceRef(mapping['evidenceRef'])) return false
    const binding = await readBinding(deps, scope, mapping['evidenceRef'], ctx)
    const parse = await deps.documentParses.getParse(scope, span.parseId, ctx)
    if (binding === undefined || parse === undefined || !equal(parse.scopeRef, scope) || binding['schemaVersion'] !== 'rule-policy-span-binding@1') return false
    const { evidenceRef: omitted, ...expected } = mapping
    void omitted
    const { schemaVersion: schema, ...actual } = binding
    void schema
    if (!equal(expected, actual) || !equal(mapping['sourceCoverage'], parse.coverage) || !equal(mapping['documentRef'], parse.originalRef) || !equal(mapping['documentVersionRef'], parse.documentVersionRef) || mapping['parserVersion'] !== parse.parserVersion) return false
    const read = await deps.documentSpans.readSpan({ documentRef: parse.originalRef, locator: span.locator, maxBytes: 128 * 1024 }, ctx)
    if (read.truncated === true || read.textDigest !== span.quoteDigest || digest(new TextEncoder().encode(read.text)) !== span.quoteDigest) return false
    expectedRefs.set(sha256DigestOf(mapping['evidenceRef']), mapping['evidenceRef'])
  }
  return equal([...expectedRefs.values()].map(sha256DigestOf).sort(), payload['premiseRefs'].map(sha256DigestOf).sort())
}
