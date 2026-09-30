import { sha256DigestOf } from '@ontology/core'
import type {
  ActionTrialInput,
  ActionTrialPort,
  ActionTrialReceipt,
  ImmutableArtifactWriter,
  OperationRegistry,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { findRegisteredOperation, isToolContext } from '@ontology/contracts'
import { canonicalJson } from '../types'
import type { RegisteredComputeExecutionService } from './execution-service'
import { registeredOperationDigest } from './execution-service'
import { EXAMPLE_INPUT_SCHEMA_VERSION } from './example-operation'

/**
 * Connect the synthetic validation sandbox to a registered compute action (SPEC v0.3a §3.4,
 * issue V03-014 → V03-031). A synthetic case is never a real fact: the trial encodes the case
 * fields into an isolation-marked immutable input artifact, runs the bound registered operation
 * through the ordinary compute execution chain and reports a receipt. An unbound or contract-
 * incompatible action is an explicit `blocked`/`failed` receipt, never a fabricated pass.
 */

export interface SyntheticActionTrialDependencies {
  readonly execution: RegisteredComputeExecutionService
  readonly operations: OperationRegistry
  readonly artifacts: ImmutableArtifactWriter
  readonly newId?: () => Uuid
  readonly now?: () => Rfc3339UtcTimestamp
}

export class SyntheticActionTrial implements ActionTrialPort {
  readonly #execution: RegisteredComputeExecutionService
  readonly #operations: OperationRegistry
  readonly #artifacts: ImmutableArtifactWriter
  readonly #newId: () => Uuid
  readonly #now: () => Rfc3339UtcTimestamp

  constructor(dependencies: SyntheticActionTrialDependencies) {
    this.#execution = dependencies.execution
    this.#operations = dependencies.operations
    this.#artifacts = dependencies.artifacts
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async trial(input: ActionTrialInput, ctx: ToolContext): Promise<ActionTrialReceipt> {
    const recordedAt = this.#now()
    const binding = input.binding
    const operationRef = binding.operationRef
    if (!binding.executable || binding.status !== 'executable' || operationRef === undefined) {
      return {
        actionId: binding.actionId,
        caseId: input.caseId,
        status: 'blocked',
        message: 'the action has no executable registered operation binding',
        recordedAt,
      }
    }
    const operation = findRegisteredOperation(this.#operations, operationRef)
    if (operation === undefined) {
      return {
        actionId: binding.actionId,
        caseId: input.caseId,
        status: 'blocked',
        message: `operation ${operationRef.id}@${operationRef.version} is not registered`,
        recordedAt,
      }
    }
    const scopeRef = scopeOf(ctx)
    const snapshot = await this.#archiveInput(input, scopeRef, ctx)
    const parametersDigest = sha256DigestOf(canonicalJson({}))
    try {
      const result = await this.#execution.execute(
        {
          taskBindingRef: this.#taskBindingRef(binding.actionId, input.declaration),
          operationRef,
          registeredOperationDigest: registeredOperationDigest(operation),
          inputSnapshotRef: snapshot,
          inputSnapshotDigest: snapshot.digest,
          parametersRef: this.#mintRef({ parameters: {} }),
          parametersDigest,
          parameters: {},
          inputRefs: [snapshot],
          requiredInputRefs: [snapshot],
          deadline: ctx.deadline,
          signal: new AbortController().signal,
        },
        ctx,
      )
      if (result.artifact.domainStatus !== 'known') {
        return {
          actionId: binding.actionId,
          caseId: input.caseId,
          status: 'failed',
          message: `the trial computed a ${result.artifact.domainStatus} result`,
          outputDigest: result.artifact.outputDigest,
          recordedAt,
        }
      }
      return {
        actionId: binding.actionId,
        caseId: input.caseId,
        status: 'passed',
        message: 'the registered operation executed on the synthetic input',
        outputDigest: result.artifact.outputDigest,
        recordedAt,
      }
    } catch (error) {
      return {
        actionId: binding.actionId,
        caseId: input.caseId,
        status: 'blocked',
        message: error instanceof Error ? error.message : 'the trial execution failed',
        recordedAt,
      }
    }
  }

  async #archiveInput(
    input: ActionTrialInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const rows = input.fields.map((field) => ({
      id: field.fieldId,
      amount:
        typeof field.value === 'number' || typeof field.value === 'string' ? String(field.value) : '',
      ...(field.unitCode === undefined ? {} : { unit: field.unitCode }),
    }))
    const stored = await this.#artifacts.putBytes(
      {
        scopeRef,
        content: new TextEncoder().encode(
          canonicalJson({ schemaVersion: EXAMPLE_INPUT_SCHEMA_VERSION, synthetic: true, rows }),
        ),
        mediaType: 'application/json',
      },
      ctx,
    )
    return stored.blobRef
  }

  #taskBindingRef(actionId: string, declaration: ActionTrialInput['declaration']): VersionRef {
    return {
      id: `synthetic-trial.${actionId}`,
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(declaration)),
    }
  }

  #mintRef(body: unknown): ResourceRef {
    return { id: this.#newId(), version: '1.0.0', digest: sha256DigestOf(canonicalJson(body)), kind: 'artifact' }
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new Error('a host-minted trusted tool context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
