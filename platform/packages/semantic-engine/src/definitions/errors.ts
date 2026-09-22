import type { FieldError } from '@ontology/contracts'

/**
 * A single reason a definition version cannot be published. Each issue carries a
 * classified code, a JSON-pointer-ish location and a human reason. Validation returns
 * every issue; it never drops one or substitutes a default.
 */
export type DefinitionValidationIssueCode =
  | 'INVALID_NAMESPACE'
  | 'INVALID_VERSION'
  | 'INVALID_IDENTIFIER'
  | 'NAMESPACE_MISMATCH'
  | 'DUPLICATE_DEFINITION'
  | 'STANDARD_PROVENANCE_MISSING'
  | 'STANDARD_PROVENANCE_INVALID'
  | 'ATTRIBUTE_OBJECT_UNKNOWN'
  | 'RELATION_ENDPOINT_UNKNOWN'
  | 'IDENTITY_SCOPE_UNKNOWN'
  | 'IDENTITY_SCOPE_EMPTY'
  | 'IDENTITY_SCOPE_ATTRIBUTE_UNKNOWN'
  | 'IDENTITY_ATTRIBUTE_INVALID'
  | 'CARDINALITY_INVALID'
  | 'CARDINALITY_KIND_CONFLICT'
  | 'UNIT_REQUIRED'
  | 'UNIT_FORBIDDEN'
  | 'UNIT_INVALID'
  | 'ENUM_REQUIRED'
  | 'ENUM_FORBIDDEN'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_FORBIDDEN'
  | 'RULE_REFERENCE_UNKNOWN'
  | 'RULE_EXPRESSION_INVALID'
  | 'CORE_SHADOWING_FORBIDDEN'
  | 'LAYER_BASE_REQUIRED'
  | 'LAYER_BASE_FORBIDDEN'
  | 'PURITY_VIOLATION'

export interface DefinitionValidationIssue {
  readonly code: DefinitionValidationIssueCode
  /** JSON-pointer-ish location, e.g. `$.attributes[2].cardinality`. */
  readonly pointer: string
  readonly reason: string
}

/**
 * Classified failures of definition publication and version binding. A caller maps these
 * onto the C6.2 error table by `code` and never has to inspect a message.
 *
 * `INVALID_DEFINITION` always carries the exact issues, so an illegal reference or a
 * contradictory cardinality fails loudly with a typed reason instead of being dropped.
 */
export type SemanticDefinitionErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'INVALID_DEFINITION'
  | 'DEFINITION_VERSION_CONFLICT'
  | 'DEFINITION_NOT_FOUND'
  | 'BASE_VERSION_NOT_FOUND'
  | 'BINDING_NOT_FOUND'
  | 'BINDING_CONFLICT'
  | 'AUDIT_PERSIST_FAILED'

export interface SemanticDefinitionErrorOptions {
  readonly cause?: unknown
  readonly issues?: readonly DefinitionValidationIssue[]
}

export class SemanticDefinitionError extends Error {
  readonly code: SemanticDefinitionErrorCode
  readonly issues: readonly DefinitionValidationIssue[] | undefined

  constructor(
    code: SemanticDefinitionErrorCode,
    message: string,
    options?: SemanticDefinitionErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SemanticDefinitionError'
    this.code = code
    this.issues = options?.issues
  }
}

/** Validation issues rendered as the shared `FieldError` wire shape. */
export function toFieldErrors(issues: readonly DefinitionValidationIssue[]): FieldError[] {
  return issues.map((issue) => ({
    pointer: issue.pointer,
    reason: `${issue.code}: ${issue.reason}`,
  }))
}
