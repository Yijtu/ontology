import type { PublishedStatement, ResourceRef, SourceRef, VersionRef } from '@ontology/contracts'
import type {
  AttributeProjectionIssue,
  PublishedAttributeProjection,
  RuleAssertionValue,
  RuleFact,
} from './types'
import { canonicalDecimalString } from './values'

export interface PublishedAttributeProjectionOptions {
  /** The schema pinned by the publication page; statements currently do not repeat this field. */
  readonly schemaRef: VersionRef
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function unitCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return undefined
  if (value === '%') return value
  return /^[A-Za-z][A-Za-z0-9_./%*^-]*$/.test(value) ? value : undefined
}

function sourceRefOf(statement: PublishedStatement): SourceRef {
  const first = statement.sourceRefs[0]
  return first === undefined
    ? { namespace: 'published', sourceId: statement.statementId }
    : { namespace: first.kind, sourceId: first.id }
}

function sourceRefsOf(statement: PublishedStatement): readonly ResourceRef[] {
  return statement.sourceRefs.map((ref) => ({ ...ref }))
}

function operationOf(statement: PublishedStatement): RuleFact['op'] {
  if (statement.status === 'retracted') return 'retract'
  const revision = Number(statement.version)
  return Number.isFinite(revision) && revision > 1 ? 'correct' : 'assert'
}

function exactValueOf(value: unknown, unitCode: unknown): { value?: RuleAssertionValue; issue?: string } {
  const nested = recordOf(value)
  if (nested !== undefined && typeof nested['amount'] === 'string') {
    const amount = canonicalDecimalString(nested['amount'])
    const unit = unitCodeOf(nested['unit'])
    if (amount === undefined || unit === undefined) return { issue: 'decimal quantity has an invalid amount or unit' }
    if (unitCode !== undefined && unitCode !== unit) return { issue: 'attribute unitCode disagrees with its DecimalQuantity unit' }
    return { value: { amount, unit } }
  }

  if (typeof value === 'string' && unitCode !== undefined) {
    const amount = canonicalDecimalString(value)
    const unit = unitCodeOf(unitCode)
    if (amount === undefined) return { issue: 'unit-bearing string value is not a valid decimal' }
    if (unit === undefined) return { issue: 'attribute unitCode is malformed' }
    return { value: { amount, unit } }
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    if (unitCode !== undefined) return { issue: 'categorical values cannot carry a unitCode' }
    return { value }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return { issue: 'numeric value is non-finite or exceeds exact integer precision' }
    }
    const amount = canonicalDecimalString(String(value))
    if (amount === undefined) return { issue: 'numeric value cannot be represented as a plain decimal' }
    const unit = unitCodeOf(unitCode)
    if (unit === undefined) return { issue: 'numeric attribute requires a valid unitCode' }
    return { value: { amount, unit } }
  }

  return { issue: 'attribute value must be an exact quantity, string or boolean' }
}

function factId(statementId: string, attributeId: string, version: string, occurrence: number, count: number): string {
  const base = `${statementId}#${encodeURIComponent(attributeId)}@${encodeURIComponent(version)}`
  return count === 1 ? base : `${base}#${String(occurrence)}`
}

/**
 * Project immutable entity statements into immutable per-attribute facts. The parent statement
 * remains the invalidation and provenance anchor; each child keeps a stable logical id across
 * statement revisions and a versioned assertion id for historical reads.
 */
function projectFacts(
  statements: readonly PublishedStatement[],
  schemaRef?: VersionRef,
): PublishedAttributeProjection {
  const facts: RuleFact[] = []
  const issues: AttributeProjectionIssue[] = []

  for (const statement of statements) {
    const valueRecord = recordOf(statement.value)
    const rawAttributes = valueRecord?.['attributes']
    if (Array.isArray(rawAttributes)) {
      const parsed = rawAttributes.map((entry, index) => ({ entry: recordOf(entry), index }))
      const counts = new Map<string, number>()
      for (const { entry } of parsed) {
        const attributeId = entry?.['attributeId']
        if (typeof attributeId !== 'string' || attributeId.length === 0) continue
        counts.set(attributeId, (counts.get(attributeId) ?? 0) + 1)
      }

      for (const { entry, index } of parsed) {
        const attributeId = entry?.['attributeId']
        if (typeof attributeId !== 'string' || attributeId.length === 0) {
          issues.push({
            statementId: statement.statementId,
            code: 'MALFORMED_ATTRIBUTE',
            message: `attribute entry ${String(index)} has no non-empty attributeId`,
          })
          continue
        }
        if ((counts.get(attributeId) ?? 0) > 1) {
          issues.push({
            statementId: statement.statementId,
            attributeId,
            code: 'DUPLICATE_ATTRIBUTE_ID',
            message: `statement contains multiple values for ${attributeId}; preserve all as a conflict-capable group`,
          })
        }

        const converted = exactValueOf(entry?.['value'], entry?.['unitCode'])
        if (converted.issue !== undefined) {
          issues.push({
            statementId: statement.statementId,
            attributeId,
            code: 'INVALID_VALUE',
            message: converted.issue,
          })
        }
        const occurrence = parsed
          .slice(0, index)
          .filter((candidate) => candidate.entry?.['attributeId'] === attributeId).length
        const subject = statement.subjectEntityId ?? ''
        facts.push({
          assertionId: factId(statement.statementId, attributeId, statement.version, occurrence, counts.get(attributeId) ?? 1),
          logicalAssertionId: `${statement.statementId}#${encodeURIComponent(attributeId)}`,
          recordedSeq: statement.version,
          op: operationOf(statement),
          subject,
          predicate: attributeId,
          ...(converted.value === undefined ? {} : { value: converted.value }),
          sourceStatementId: statement.statementId,
          ...(statement.objectId === undefined ? {} : { objectId: statement.objectId }),
          attributeId,
          ...(schemaRef === undefined ? {} : { schemaRef }),
          validity: {
            validFrom: statement.validFrom ?? statement.recordedAt,
            ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }),
          },
          sourceRef: sourceRefOf(statement),
          sourceRefs: sourceRefsOf(statement),
        })
      }
      continue
    }

    if (rawAttributes !== undefined) {
      issues.push({
        statementId: statement.statementId,
        code: 'MALFORMED_ATTRIBUTES',
        message: 'statement value.attributes must be an array',
      })
    }

    const scalar = exactValueOf(valueRecord?.['value'] ?? statement.value, valueRecord?.['unitCode'] ?? statement.unitCode)
    if (scalar.issue !== undefined) {
      // A structured statement with no supported scalar stays explicit but unknown.
      if (scalar.issue !== 'attribute value must be an exact quantity, string or boolean') {
        issues.push({
          statementId: statement.statementId,
          code: 'INVALID_VALUE',
          message: scalar.issue,
        })
      }
    }
    facts.push({
      assertionId: statement.statementId,
      logicalAssertionId: statement.statementId,
      recordedSeq: statement.version,
      op: operationOf(statement),
      subject: statement.subjectEntityId ?? statement.objectId ?? statement.relationId ?? '',
      predicate: statement.predicate,
      ...(scalar.value === undefined ? {} : { value: scalar.value }),
      sourceStatementId: statement.statementId,
      ...(statement.objectId === undefined ? {} : { objectId: statement.objectId }),
      ...(schemaRef === undefined ? {} : { schemaRef }),
      validity: {
        validFrom: statement.validFrom ?? statement.recordedAt,
        ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }),
      },
      sourceRef: sourceRefOf(statement),
      sourceRefs: sourceRefsOf(statement),
    })
  }

  return {
    facts: facts.sort((left, right) => left.assertionId.localeCompare(right.assertionId)),
    issues: issues.sort((left, right) =>
      left.statementId.localeCompare(right.statementId) ||
      (left.attributeId ?? '').localeCompare(right.attributeId ?? '') ||
      left.code.localeCompare(right.code),
    ),
  }
}

export function projectPublishedAttributeFacts(
  statements: readonly PublishedStatement[],
  options: PublishedAttributeProjectionOptions,
): PublishedAttributeProjection {
  return projectFacts(statements, options.schemaRef)
}

/** Compatibility name for callers that only need facts; diagnostics are available above. */
export function ruleFactsFromStatements(
  statements: readonly PublishedStatement[],
  options?: Partial<PublishedAttributeProjectionOptions>,
): RuleFact[] {
  return [...projectFacts(statements, options?.schemaRef).facts]
}
