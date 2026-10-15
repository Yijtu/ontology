import type {
  ComputeOperationHandler,
  ComputeOperationRequest,
  ComputeOperationResult,
  OperationRef,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  ToolContext,
} from '@ontology/contracts'
import { computeOperationKey } from '@ontology/contracts'
import { ToolGatewayError } from '../errors'
import { isRecord } from '../envelope'
import type { ToolExecutionOutcome } from '../types'
import { raceWithAbort } from '../cancellation'

/**
 * `data_query.kind=compute` dispatch (ADR-11, C3/C4).
 *
 * The gateway has already resolved the call against the registered operations and the
 * resolved profile. This module enforces the remaining compute-only invariants before the
 * registered industry handler runs:
 *   - the parameters carry no file/network/script bypass field;
 *   - the handler only reads the approved immutable input refs (a scoped reader);
 *   - the operation's declared CPU budget and the propagated deadline are honoured;
 *   - the handler archives its result through the immutable, content-addressed writer.
 *
 * There is deliberately no `eval`, no script body and no dynamic import here: the handler
 * is chosen by the registered `operationRef`, never by model input.
 */

/** Keys that can never appear in a compute parameter graph. `code`/`script`/`eval` are also
 * rejected globally by `assertNoMaliciousKeys`; this adds the file/network bypass shapes. */
const COMPUTE_BYPASS_KEYS: ReadonlySet<string> = new Set([
  'file',
  'filePath',
  'fileName',
  'filename',
  'path',
  'paths',
  'url',
  'uri',
  'network',
  'fetch',
  'http',
  'https',
  'request',
  'command',
  'shell',
  'stdin',
  'stdout',
])

/** A scheme-qualified URL, an absolute POSIX path, a Windows drive path or a UNC path. */
const BYPASS_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\\\\|[a-zA-Z]:[\\/])/

export function resolveComputeHandler(
  handlers: readonly ComputeOperationHandler[],
  operationRef: OperationRef,
): ComputeOperationHandler | undefined {
  const key = computeOperationKey(operationRef)
  return handlers.find((handler) => computeOperationKey(handler.operationRef) === key)
}

/**
 * Reject any attempt to smuggle a file path, URL or network access through the typed
 * parameters or the read-only input references. A well-formed compute call never needs one:
 * the operation is registered and reads only approved immutable artifacts.
 */
export function assertNoComputeBypass(
  parameters: Readonly<Record<string, unknown>>,
  inputRefs: readonly ResourceRef[],
): void {
  const issues: { pointer: string; reason: string }[] = []
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (depth > 32) return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${pointer}/${String(index)}`, depth + 1))
      return
    }
    if (isRecord(node)) {
      for (const [key, entry] of Object.entries(node)) {
        const child = `${pointer}/${key}`
        if (COMPUTE_BYPASS_KEYS.has(key)) {
          issues.push({ pointer: child, reason: `the field ${key} is not permitted in compute parameters` })
          continue
        }
        visit(entry, child, depth + 1)
      }
      return
    }
    if (typeof node === 'string' && BYPASS_VALUE.test(node)) {
      issues.push({ pointer, reason: 'a file path or URL is not a permitted compute value' })
    }
  }
  visit(parameters, '/parameters', 0)
  for (const [index, ref] of inputRefs.entries()) {
    if (BYPASS_VALUE.test(ref.id)) {
      issues.push({
        pointer: `/inputRefs/${String(index)}/id`,
        reason: 'an input reference must be an internal immutable artifact id, not a path or URL',
      })
    }
  }
  if (issues.length > 0) {
    throw new ToolGatewayError(
      'MALICIOUS_ARGUMENTS',
      'the compute call carries a file, network or script bypass field',
      { fieldErrors: issues },
    )
  }
}

/**
 * Bind a reader to exactly the execution's approved input refs. A handler can read only
 * those refs; any other request is refused, so a handler never receives a general
 * filesystem or database credential (C3).
 */
export function createScopedArtifactReader(
  inner: ScopedArtifactReader,
  approved: readonly ResourceRef[],
): ScopedArtifactReader {
  const key = (ref: ResourceRef): string => JSON.stringify([ref.kind, ref.id, ref.version, ref.digest])
  const allowed = new Set(approved.map(key))
  return {
    async read(request: ScopedArtifactReaderRequest, ctx: ToolContext): Promise<Uint8Array> {
      for (const ref of request.approvedInputRefs) {
        if (!allowed.has(key(ref))) {
          throw new ToolGatewayError(
            'RESOURCE_NOT_ALLOWED',
            `the compute handler tried to read ${ref.id}, which is not an approved input`,
            { fieldErrors: [{ pointer: '/inputRefs', reason: 'input is not approved for this execution' }] },
          )
        }
      }
      const target = request.approvedInputRefs[0]
      if (target === undefined) {
        throw new ToolGatewayError('INVALID_ARGUMENTS', 'a scoped read requires an approved input ref')
      }
      return inner.read({ approvedInputRefs: [target] }, ctx)
    },
  }
}

/**
 * Run the registered handler under the operation's CPU budget and the propagated deadline.
 * A handler that overruns is abandoned with `DEADLINE_EXCEEDED`; the gateway's own timer
 * aborts the signal at the run deadline, so a handler that ignores its budget still cannot
 * hold the run open indefinitely.
 */
export async function runComputeWithBudget(
  work: (request: { readonly signal: AbortSignal }) => Promise<ComputeOperationResult>,
  budgetMs: number,
  deadline: string,
  outerSignal: AbortSignal,
): Promise<ComputeOperationResult> {
  if (outerSignal.aborted) {
    throw new ToolGatewayError('HANDLER_FAILED', 'the compute operation was cancelled before it started', {
      platformCode: 'DEADLINE_EXCEEDED',
    })
  }
  const remaining = Date.parse(deadline) - Date.now()
  const effectiveMs = Math.max(0, Math.min(budgetMs, remaining))
  if (effectiveMs <= 0) {
    throw new ToolGatewayError('HANDLER_FAILED', 'the compute operation has no remaining CPU budget', {
      platformCode: 'DEADLINE_EXCEEDED',
    })
  }
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(outerSignal.reason)
  outerSignal.addEventListener('abort', forwardAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort('cpu budget exceeded')
        reject(
          new ToolGatewayError('HANDLER_FAILED', 'the compute operation exceeded its CPU/deadline budget', {
            platformCode: 'DEADLINE_EXCEEDED',
          }),
        )
      }, effectiveMs)
    })
    return await raceWithAbort(Promise.race([work({ signal: controller.signal }), timeout]), outerSignal, 'the compute operation was cancelled')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal.removeEventListener('abort', forwardAbort)
  }
}

/** Convert a contract compute result into the generic tool outcome the gateway persists. */
export function computeOutcomeOf(result: ComputeOperationResult): ToolExecutionOutcome {
  return {
    payload: { ...result.payload, coverage: result.coverage },
    status: result.status,
    coverage: result.coverage,
    sources: result.sources.map((source) => ({
      sourceRef: source.sourceRef,
      schemaVersion: source.schemaVersion,
      ...(source.asOf === undefined ? {} : { asOf: source.asOf }),
      ...(source.watermark === undefined ? {} : { watermark: source.watermark }),
      consistency: source.consistency,
      ...(source.resultDigest === undefined ? {} : { resultDigest: source.resultDigest }),
    })),
    ...(result.warnings === undefined ? {} : { warnings: [...result.warnings] }),
    ...(result.domainStatus === undefined ? {} : { domainStatus: result.domainStatus }),
    dataMode: result.dataMode,
    evidenceKind: result.evidenceKind,
  }
}

export function computeRequestOf(input: {
  readonly operationRef: OperationRef
  readonly parameters: Readonly<Record<string, unknown>>
  readonly inputRefs: readonly ResourceRef[]
  readonly readInput: ScopedArtifactReader
  readonly artifacts: ComputeOperationRequest['artifacts']
  readonly limits: ComputeOperationRequest['limits']
  readonly deadline: string
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}): ComputeOperationRequest {
  return {
    operationRef: input.operationRef,
    parameters: input.parameters,
    inputRefs: input.inputRefs,
    readInput: input.readInput,
    artifacts: input.artifacts,
    limits: input.limits,
    deadline: input.deadline,
    ctx: input.ctx,
    signal: input.signal,
  }
}
