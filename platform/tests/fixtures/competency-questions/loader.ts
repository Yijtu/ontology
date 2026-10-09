import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import { assertCompetencyQuestionSet, COMPETENCY_QUESTION_SCHEMA_ID, SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type { CompetencyQuestionBoundary, CompetencyQuestionSet, VersionRef } from '@ontology/contracts'
import { COMPETENCY_ASSETS, CQ_ADDITIONAL_SOURCES, canonicalCompetencyJson, competencyDigest, byteDigest } from './assets'

export const competencyFixtureDirectory = fileURLToPath(new URL('./', import.meta.url))
const sameRef = (a: VersionRef, b: VersionRef): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest

export function competencyQuestionBoundary(): CompetencyQuestionBoundary {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const schema of SCHEMA_DOCUMENTS) ajv.addSchema(schema as SchemaObject)
  return { schemaId: COMPETENCY_QUESTION_SCHEMA_ID, validate: ajv.compile<CompetencyQuestionSet>({ $ref: COMPETENCY_QUESTION_SCHEMA_ID }), digestBody: competencyDigest }
}

/** Load immutable authored inputs/gold only. No evaluator, query, materializer or model runs here. */
export function loadCompetencyQuestions(): readonly CompetencyQuestionSet[] {
  const boundary = competencyQuestionBoundary()
  return (['transport', 'industrial'] as const).map((industry) => {
    const raw: unknown = JSON.parse(readFileSync(new URL(`${industry}.cq.json`, import.meta.url), 'utf8'))
    assertCompetencyQuestionSet(raw, boundary)
    const assets = COMPETENCY_ASSETS[industry]
    const persistedAssets: unknown = JSON.parse(readFileSync(new URL(`${industry}.assets.json`, import.meta.url), 'utf8'))
    if (canonicalCompetencyJson(persistedAssets) !== canonicalCompetencyJson({ definitions: assets.definitions, rules: assets.rules })) throw new Error('stored declaration assets differ from their immutable typed source')
    const bytes = readFileSync(new URL(`${industry}.source.txt`, import.meta.url))
    if (byteDigest(bytes) !== assets.document.ref.digest || !raw.body.sourceRefs.some((ref) => sameRef(ref, assets.document.ref))) throw new Error('actual source bytes do not match the declared source pin')
    const sources = [{ ref: assets.document.ref, bytes }, ...CQ_ADDITIONAL_SOURCES.filter((source) => source.industry === industry).map((source) => {
      const bytes = readFileSync(new URL(source.filename, import.meta.url))
      if (byteDigest(bytes) !== source.document.ref.digest || bytes.includes(13)) throw new Error('independent original source bytes differ from the authored LF pin')
      return { ref: source.document.ref, bytes }
    })]
    for (const ref of raw.body.sourceRefs) if (!sources.some((source) => sameRef(source.ref, ref))) throw new Error('unknown original source inventory pin')
    for (const ref of raw.body.definitionRefs) if (!assets.definitions.some((definition) => sameRef(ref, definition.ref))) throw new Error('unknown fixture definition pin')
    for (const ref of raw.body.ruleRefs) if (!assets.rules.some((rule) => sameRef(ref, rule.ref))) throw new Error('unknown fixture rule pin')
    for (const question of raw.body.questions) {
      for (const location of question.requiredSources) {
        const original = sources.find((source) => sameRef(source.ref, location.sourceRef))?.bytes
        if (original === undefined || location.endOffset > original.length || byteDigest(original.subarray(location.startOffset, location.endOffset)) !== location.quoteDigest) throw new Error('actual source offset/quote digest differs')
      }
      const intent = question.intent
      if (intent.kind === 'rule' && !assets.rules.some((rule) => rule.declaration.ruleId === intent.ruleId && question.ruleRefs.some((ref) => sameRef(ref, rule.ref)))) throw new Error('rule intent is not pinned to an authored rule declaration')
    }
    return raw
  })
}
