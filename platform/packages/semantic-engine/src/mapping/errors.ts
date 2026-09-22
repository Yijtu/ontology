import type { FieldError } from '@ontology/contracts'

/**
 * Classified failures of semantic mapping resolution, query compilation and local
 * ontology lookup. A caller maps these onto the C6.2 error table by `code`; it never
 * inspects a message.
 *
 * `BUDGET_EXCEEDED` and `CROSS_SOURCE_JOIN_REFUSED` are the two ways an unbounded pull is
 * refused instead of executed; `UNMAPPED_*`/`IDENTIFIER_NOT_FROM_MAPPING` are how a
 * crafted concept/field id or filter value is stopped from ever becoming an identifier.
 */
export type SemanticMappingErrorCode =
  | 'SCOPE_MISMATCH'
  | 'MAPPING_NOT_FOUND'
  | 'MAPPING_VERSION_MISMATCH'
  | 'INVALID_MAPPING'
  | 'INVALID_QUERY_PLAN'
  | 'UNMAPPED_CONCEPT'
  | 'UNMAPPED_FIELD'
  | 'UNMAPPED_LINK'
  | 'AMBIGUOUS_FIELD'
  | 'JOIN_RELATION_REQUIRED'
  | 'CROSS_SOURCE_JOIN_REFUSED'
  | 'RELATION_KEY_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_FILTER_VALUE'
  | 'UNSUPPORTED_AGGREGATION'
  | 'TIME_FIELD_UNMAPPED'
  | 'IDENTIFIER_NOT_FROM_MAPPING'

export interface SemanticMappingErrorOptions extends ErrorOptions {
  readonly fieldErrors?: readonly FieldError[]
}

export class SemanticMappingError extends Error {
  readonly code: SemanticMappingErrorCode
  readonly fieldErrors: readonly FieldError[] | undefined

  constructor(
    code: SemanticMappingErrorCode,
    message: string,
    options?: SemanticMappingErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SemanticMappingError'
    this.code = code
    this.fieldErrors = options?.fieldErrors
  }
}

export function isSemanticMappingError(value: unknown): value is SemanticMappingError {
  return value instanceof SemanticMappingError
}
