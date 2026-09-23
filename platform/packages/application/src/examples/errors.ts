/**
 * Few-shot example retrieval errors (LOCAL-076).
 *
 * The retriever classifies only the failures it owns — a malformed request or a
 * non-trusted context. A search-backend failure is not an exception path: it is
 * reported as an explicit `unavailable` status so the caller never mistakes a failed
 * retrieval for "no example exists" (C4/C6.2).
 */
export type FewShotExampleErrorCode = 'INVALID_ARGUMENT' | 'SCOPE_MISMATCH'

export class FewShotExampleError extends Error {
  readonly code: FewShotExampleErrorCode

  constructor(code: FewShotExampleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FewShotExampleError'
    this.code = code
  }
}

export function isFewShotExampleError(value: unknown): value is FewShotExampleError {
  return value instanceof FewShotExampleError
}
