import type { FieldError } from '@ontology/contracts'

/**
 * Classified failures of component registration and lifecycle management (C1, D2).
 *
 * A caller maps these to the C6.2 error table by `code`; it never has to inspect a
 * message. An invalid manifest is reported with `INVALID_MANIFEST` plus the exact
 * field errors, so a rejected registration is explicit instead of a silent drop.
 */
export type ComponentRegistryErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MANIFEST'
  | 'DYNAMIC_INSTALL_FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_RETIRED'
  | 'ILLEGAL_TRANSITION'
  | 'ACTIVE_REFERENCE_EXISTS'
  | 'ARTIFACT_NOT_AUTHORIZED'
  | 'AUDIT_PERSIST_FAILED'

export interface ComponentRegistryErrorOptions {
  readonly cause?: unknown
  readonly fieldErrors?: readonly FieldError[]
}

export class ComponentRegistryError extends Error {
  readonly code: ComponentRegistryErrorCode
  readonly fieldErrors: readonly FieldError[] | undefined

  constructor(
    code: ComponentRegistryErrorCode,
    message: string,
    options?: ComponentRegistryErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ComponentRegistryError'
    this.code = code
    this.fieldErrors = options?.fieldErrors
  }
}
