import { createHash } from 'node:crypto'
import { RunServiceError, canonicalJson, parseCreateRunRequest, sha256DigestOf } from '@ontology/application'
import { isRecord, isResourceRef, isUuid, isVersionRef } from '@ontology/contracts'
import type { ProjectRevision, ProjectStore, PublishedTaskBinding, ResourceRef, RunExecutionBindingStore, RunStore, ScopeRef, ScopedArtifactReader, TaskBindingStore, ToolContext } from '@ontology/contracts'
import type { createCoreApprovedInput } from './core-approved-input'
import type { createCoreAuthoring } from './core-authoring'

/** Selectors cross HTTP; fixed project/input/time pins are resolved from actual host stores. */
export function createCoreRunRequestResolver(options: {
  readonly projects: ProjectStore; readonly runs: RunStore; readonly bindings: RunExecutionBindingStore; readonly tasks: TaskBindingStore
  readonly inputs: ReturnType<typeof createCoreApprovedInput>; readonly authoring: ReturnType<typeof createCoreAuthoring>; readonly reader: ScopedArtifactReader
  readonly now?: () => string
  readonly prepareComputeInput?: (scope: ScopeRef, revision: ProjectRevision, base: ResourceRef, binding: PublishedTaskBinding, selection: unknown, ctx: ToolContext, signal: AbortSignal) => Promise<ResourceRef>
}) {
  return async (body: unknown, ctx: ToolContext, idempotencyKey: string, signal: AbortSignal): Promise<unknown> => {
    if (!isRecord(body) || body['projectId'] === undefined) return body
    if (!isUuid(body['projectId']) || Object.keys(body).some((key) => !['profileRef', 'question', 'context', 'preferences', 'projectId', 'task'].includes(key))) throw new RunServiceError('INVALID_ARGUMENT', 'normal project runs accept only project, question and declared task selectors')
    const check = () => { if (signal.aborted) throw new RunServiceError('DEADLINE_EXCEEDED', 'the normal run submission was cancelled', { cause: signal.reason }) }
    check()
    const projectId = body['projectId'], scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const rawDigest = sha256DigestOf(canonicalJson(body)), identity = `normal-run-submission:${idempotencyKey}`
    const existing = await options.authoring.findStableArtifact(identity, ctx)
    const projectFor = async () => {
      const project = await options.projects.getProject(scope, projectId, ctx)
      const revision = project === undefined ? undefined : await options.projects.getRevision(scope, projectId, project.activeRevision ?? project.headRevision, ctx)
      if (project === undefined || project.state === 'archived' || revision === undefined) throw new RunServiceError('INVALID_ARGUMENT', 'the active project is unavailable in this scope')
      if (revision.executionPurpose === 'synthetic_validation') throw new RunServiceError('INVALID_ARGUMENT', 'private competency inputs cannot be submitted as ordinary observed business tasks')
      return revision
    }
    if (existing !== undefined) {
      const bytes = await options.reader.read({ approvedInputRefs: [existing] }, ctx)
      if (bytes.byteLength > 1_048_576 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== existing.digest) throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the saved submission bytes failed integrity')
      const archived: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!isRecord(archived) || archived['schemaVersion'] !== 'core-normal-run-submission@1' || archived['rawDigest'] !== rawDigest || canonicalJson(archived['principal']) !== canonicalJson(ctx.principal)) throw new RunServiceError('IDEMPOTENCY_CONFLICT', 'this submission key was captured for another request or trusted identity')
      const resolved = parseCreateRunRequest(archived['body'])
      if (resolved.execution === undefined || resolved.execution.projectRevisionRef.projectId !== projectId) throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the saved submission has no exact project execution binding')
      const prior = await options.runs.findRunByIdempotencyKey(scope, idempotencyKey, ctx)
      if (prior !== undefined) {
        const binding = await options.bindings.getBindingByRun(scope, prior.runId, ctx)
        if (binding === undefined || canonicalJson(binding.binding.request) !== canonicalJson(resolved.execution)) throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the saved submission differs from its actual immutable run binding')
      } else {
        const revision = await projectFor()
        let input = await options.inputs.resolve(scope, revision, ctx, signal)
        if (resolved.execution.mode === 'task') {
          const selected = body['task']
          const binding = await options.tasks.getBinding(scope, resolved.execution.taskBindingRef, ctx)
          if (binding?.kind === 'compute') {
            if (!isRecord(selected) || selected['inputSelection'] === undefined || options.prepareComputeInput === undefined) throw new RunServiceError('TASK_PARAMETER_INVALID', 'choose the actual source fields for this computation')
            input = await options.prepareComputeInput(scope, revision, input, binding, selected['inputSelection'], ctx, signal)
          }
        }
        if (canonicalJson(revision.ref) !== canonicalJson(resolved.execution.projectRevisionRef) || canonicalJson(input) !== canonicalJson(resolved.execution.inputSnapshotRef)) throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the captured input changed before this run was created; submit the reviewed current project as a new request')
      }
      check()
      return archived['body']
    }
    const revision = await projectFor()
    const profile = body['profileRef']
    if (!isRecord(profile) || profile['id'] !== revision.profileRef.id || profile['version'] !== revision.profileRef.version) throw new RunServiceError('PROFILE_INCOMPATIBLE', 'a project run must use its actual resolved project profile')
    let input = await options.inputs.resolve(scope, revision, ctx, signal)
    check()
    let task: { readonly mode: 'task'; readonly taskBindingRef: { id: string; version: string; digest: string }; readonly parameters: Readonly<Record<string, unknown>> } | undefined
    if (body['task'] !== undefined) {
      const selected = body['task']
      if (!isRecord(selected) || Object.keys(selected).some((key) => !['bindingRef', 'arguments', 'inputSelection'].includes(key)) || !isVersionRef(selected['bindingRef']) || !isRecord(selected['arguments'])) throw new RunServiceError('INVALID_ARGUMENT', 'a normal task needs its exact published binding and confirmed parameters')
      const binding = await options.tasks.getBinding(scope, selected['bindingRef'], ctx)
      if (binding === undefined || canonicalJson(binding.taskBindingRef) !== canonicalJson(selected['bindingRef']) || canonicalJson(binding.actionDefinitionRef) !== canonicalJson(revision.definitionRef)) throw new RunServiceError('TASK_NOT_BOUND', 'the selected task is not published for this exact project definition')
      if (binding.kind === 'compute') {
        if (selected['inputSelection'] === undefined || options.prepareComputeInput === undefined) throw new RunServiceError('TASK_PARAMETER_INVALID', 'choose the actual identifier, amount and optional unit or currency fields for this computation')
        input = await options.prepareComputeInput(scope, revision, input, binding, selected['inputSelection'], ctx, signal)
      } else if (selected['inputSelection'] !== undefined) throw new RunServiceError('TASK_PARAMETER_INVALID', 'only a registered computation accepts a separate source field selection')
      const parameters = { ...selected['arguments'] }
      if (binding.kind === 'relations' && parameters['validAt'] === undefined) parameters['validAt'] = options.now?.() ?? new Date().toISOString()
      task = { mode: 'task', taskBindingRef: binding.taskBindingRef, parameters }
    }
    const resolved = { profileRef: { id: revision.profileRef.id, version: revision.profileRef.version }, question: body['question'], context: body['context'], preferences: body['preferences'],
      task: { mode: 'question', projectRevisionRef: revision.ref, inputSnapshotRef: input, inputSnapshotDigest: input.digest, ...task } }
    parseCreateRunRequest(resolved)
    const artifact = await options.authoring.stableWrite(identity, new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-normal-run-submission@1', rawDigest, principal: ctx.principal, body: resolved })), 'application/json', 'artifact', ctx)
    if (!isResourceRef(artifact)) throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the normal submission archive did not return a real reference')
    if (canonicalJson(await projectFor()) !== canonicalJson(revision)) throw new RunServiceError('VERSION_CONFLICT', 'the actual project changed while this submission was captured')
    check()
    return resolved
  }
}
