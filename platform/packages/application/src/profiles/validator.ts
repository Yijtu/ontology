/**
 * Canonical JSON-Schema validator for `ProfileSpec`, injected by the composition root.
 *
 * The application layer never imports a schema library (INV-01/INV-02): the host supplies
 * the validator built from the published schema bundle, so a profile that reaches the API
 * boundary is checked at runtime rather than trusted through a TypeScript assertion.
 */
export interface ProfileSpecValidationIssue {
  readonly pointer: string
  readonly message: string
}

export interface ProfileSpecValidationResult {
  readonly valid: boolean
  readonly issues: readonly ProfileSpecValidationIssue[]
}

export type ProfileSpecValidator = (spec: unknown) => ProfileSpecValidationResult
