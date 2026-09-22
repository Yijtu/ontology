import type { PublishedStatement, SourceRef } from '@ontology/contracts'
import type { RuleAssertionValue, RuleFact } from './types'
import { isDecimalQuantity } from './values'

/**
 * Adapt the official published read view into the evaluator's fact model (SPEC D5, C3/C4).
 * A statement's `value` is an open record; the evaluator only treats an exact decimal quantity
 * or a scalar `value` member as comparable. Anything else is carried as an absent value so it
 * can never be read as a determinate `false`.
 */
function scalarOf(value: Readonly<Record<string, unknown>>): RuleAssertionValue | undefined {
  if (isDecimalQuantity(value)) return { amount: value.amount, unit: value.unit }
  const inner = value['value']
  if (typeof inner === 'string' || typeof inner === 'boolean') return inner
  // A bare JSON number is deliberately not accepted as an exact value: a quantity must arrive
  // as a DecimalQuantity so no float rounding can enter rule evaluation (E4).
  return undefined
}

function sourceRefOf(statement: PublishedStatement): SourceRef {
  const first = statement.sourceRefs[0]
  return first === undefined
    ? { namespace: 'published', sourceId: statement.statementId }
    : { namespace: first.kind, sourceId: first.id }
}

/** Map published statements into immutable facts, preserving the exact recorded version. */
export function ruleFactsFromStatements(statements: readonly PublishedStatement[]): RuleFact[] {
  return statements.map((statement) => {
    const value = scalarOf(statement.value)
    return {
      assertionId: statement.statementId,
      logicalAssertionId: statement.statementId,
      recordedSeq: statement.version,
      op: statement.status === 'retracted' ? 'retract' : 'assert',
      subject: statement.subjectEntityId ?? statement.objectId ?? statement.relationId ?? '',
      predicate: statement.predicate,
      validity: {
        validFrom: statement.validFrom ?? statement.recordedAt,
        ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }),
      },
      sourceRef: sourceRefOf(statement),
      ...(value === undefined ? {} : { value }),
    }
  })
}
