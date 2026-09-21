import type { PlanArgument, PlanSpec, PlanStep } from '@ontology/contracts'
import { TemplateRuntimeError } from './errors'
import type { StepOutput } from './types'

/**
 * Why a required plan argument could not be bound. Every case produces a typed
 * clarification; the runtime never substitutes a default, a guess or a skipped value.
 */
export type MissingArgumentReason =
  | 'no_source'
  | 'predecessor_not_available'
  | 'unresolved_pointer'

export interface MissingArgument {
  readonly stepId: string
  readonly argumentName: string
  readonly reason: MissingArgumentReason
}

export type ArgumentResolution =
  | { readonly ok: true; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly missing: MissingArgument }

/**
 * Structural and semantic validation of a published plan (D7.1). It rejects the cases the
 * controller/gateway must never execute: duplicate step ids, unknown or self
 * dependencies, dependency cycles, and a predecessor binding that is not declared as a
 * dependency (which would let a node read an output before its producer ran).
 */
export function validatePlan(spec: PlanSpec): void {
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new TemplateRuntimeError('INVALID_PLAN', 'a plan must contain at least one step')
  }

  const ids = new Set<string>()
  for (const step of spec.steps) {
    if (typeof step.stepId !== 'string' || step.stepId.length === 0) {
      throw new TemplateRuntimeError('INVALID_PLAN', 'every plan step requires a non-empty stepId')
    }
    if (ids.has(step.stepId)) {
      throw new TemplateRuntimeError('INVALID_PLAN', `duplicate stepId ${step.stepId}`)
    }
    ids.add(step.stepId)
  }

  for (const step of spec.steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.stepId) {
        throw new TemplateRuntimeError('INVALID_PLAN', `step ${step.stepId} depends on itself`)
      }
      if (!ids.has(dependency)) {
        throw new TemplateRuntimeError(
          'INVALID_PLAN',
          `step ${step.stepId} depends on unknown step ${dependency}`,
        )
      }
    }
    for (const argument of step.args) {
      const source = argument.source
      if (source !== undefined && source.kind === 'predecessor') {
        if (!ids.has(source.stepId)) {
          throw new TemplateRuntimeError(
            'INVALID_PLAN',
            `step ${step.stepId} binds ${argument.name} to unknown step ${source.stepId}`,
          )
        }
        if (!step.dependsOn.includes(source.stepId)) {
          throw new TemplateRuntimeError(
            'INVALID_PLAN',
            `step ${step.stepId} binds ${argument.name} to ${source.stepId} without declaring it as a dependency`,
          )
        }
      }
    }
  }

  if (hasCycle(spec.steps, ids)) {
    throw new TemplateRuntimeError('INVALID_PLAN', 'the plan contains a dependency cycle')
  }
}

function hasCycle(steps: readonly PlanStep[], ids: ReadonlySet<string>): boolean {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    dependents.set(id, [])
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1)
      dependents.get(dependency)?.push(step.stepId)
    }
  }
  const queue = [...ids].filter((id) => (indegree.get(id) ?? 0) === 0)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    visited += 1
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  return visited !== ids.size
}

/**
 * Bind a step's arguments from literals, the actual bounded outputs of its declared
 * predecessors, and (on resume) the user's typed clarification answers. A required
 * argument that cannot be resolved is reported as missing instead of defaulted.
 */
export function resolveArguments(
  step: PlanStep,
  outputs: ReadonlyMap<string, StepOutput>,
  clarifications: Readonly<Record<string, unknown>> | undefined,
): ArgumentResolution {
  const resolved: Record<string, unknown> = {}
  for (const argument of step.args) {
    const outcome = resolveArgument(step.stepId, argument, outputs, clarifications)
    if (outcome.kind === 'missing') return { ok: false, missing: outcome.missing }
    if (outcome.kind === 'value') resolved[argument.name] = outcome.value
  }
  return { ok: true, arguments: resolved }
}

type ArgumentOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'skip' }
  | { readonly kind: 'missing'; readonly missing: MissingArgument }

function resolveArgument(
  stepId: string,
  argument: PlanArgument,
  outputs: ReadonlyMap<string, StepOutput>,
  clarifications: Readonly<Record<string, unknown>> | undefined,
): ArgumentOutcome {
  const source = argument.source
  if (source === undefined) {
    const supplied = clarifications?.[argument.name]
    if (supplied !== undefined) return { kind: 'value', value: supplied }
    if (argument.required === true) {
      return { kind: 'missing', missing: { stepId, argumentName: argument.name, reason: 'no_source' } }
    }
    return { kind: 'skip' }
  }

  if (source.kind === 'literal') {
    return { kind: 'value', value: source.value }
  }

  const predecessor = outputs.get(source.stepId)
  if (predecessor === undefined || predecessor.inlineData === undefined) {
    if (argument.required === true) {
      return {
        kind: 'missing',
        missing: { stepId, argumentName: argument.name, reason: 'predecessor_not_available' },
      }
    }
    return { kind: 'skip' }
  }

  const value = resolveJsonPointer(predecessor.inlineData, source.pointer)
  if (value === undefined) {
    if (argument.required === true) {
      return {
        kind: 'missing',
        missing: { stepId, argumentName: argument.name, reason: 'unresolved_pointer' },
      }
    }
    return { kind: 'skip' }
  }
  return { kind: 'value', value }
}

/** RFC 6901 JSON Pointer resolution. An empty pointer selects the whole value. */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  const tokens = pointer.split('/').slice(1).map(decodeToken)
  let current: unknown = value
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(record, token)) return undefined
      current = record[token]
    } else {
      return undefined
    }
  }
  return current
}

function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}
