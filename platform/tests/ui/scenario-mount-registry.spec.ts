import { describe, expect, it } from 'vitest'
import { ScenarioModuleRegistry, isLegalUiCapabilityMetadata } from '@ontology/app-web'
import type { FrontendScenarioModule, ScenarioMount } from '@ontology/app-web'
import type { UiCapabilityMetadata, VersionRef } from '@ontology/contracts'

function digest(seed: string): string {
  const code = seed.codePointAt(0) ?? 97
  return `sha256:${((code % 16).toString(16)).repeat(64)}`
}

const MODULE_REF: VersionRef = { id: 'scene.neutral.alpha', version: '1.0.0', digest: digest('a') }
const TASK_REF: VersionRef = { id: 'task.neutral.alpha.run', version: '1.0.0', digest: digest('b') }
const EXPORT_REF: VersionRef = { id: 'capability.neutral.export', version: '1.0.0', digest: digest('c') }

function module(): FrontendScenarioModule {
  return {
    ref: MODULE_REF,
    capabilityRequirements: ['data.readonly'],
    taskEntries: [{ taskBindingRef: TASK_REF, label: '中性任务' }],
    ParameterPanel: () => null,
    ResultRenderer: () => null,
    exporters: [{ id: 'alpha-json', label: 'Alpha JSON', format: 'json', exportCapabilityRef: EXPORT_REF }],
  }
}

function declaration(overrides: Partial<UiCapabilityMetadata> = {}): UiCapabilityMetadata {
  return {
    moduleRef: MODULE_REF,
    taskBindingRefs: [TASK_REF],
    requiredCapabilities: ['data.readonly'],
    ...overrides,
  }
}

function registered(): ScenarioModuleRegistry {
  const registry = new ScenarioModuleRegistry()
  registry.register(module())
  return registry
}

function kindOf(mount: ScenarioMount): ScenarioMount['kind'] {
  return mount.kind
}

describe('scenario mount registry and controlled legal projection', () => {
  it('accepts a well-formed moduleRef declaration and projects data-only module metadata', () => {
    const mount = registered().mount(declaration(), { grantedCapabilities: ['data.readonly'] })
    expect(kindOf(mount)).toBe('mounted')
    if (mount.kind !== 'mounted') throw new Error('expected a mounted module')
    expect(mount.view.moduleRef).toEqual(MODULE_REF)
    expect(mount.view.taskEntries).toHaveLength(1)
    expect(mount.view.exporters.map((entry) => entry.id)).toEqual(['alpha-json'])
    expect(mount.view.hasParameterPanel).toBe(true)
    expect(mount.view.hasResultRenderer).toBe(true)
    // The projection carries only data: no component, HTML or remote import leaks through.
    expect(Object.keys(mount.view).sort()).toEqual(
      ['capabilityRequirements', 'exporters', 'hasParameterPanel', 'hasResultRenderer', 'moduleRef', 'taskEntries'],
    )
  })

  it('rejects declarations that are not a legal UiCapabilityMetadata projection', () => {
    expect(isLegalUiCapabilityMetadata(declaration())).toBe(true)
    expect(isLegalUiCapabilityMetadata({ ...declaration(), remoteUrl: 'https://example.invalid/module.js' })).toBe(false)
    expect(isLegalUiCapabilityMetadata({ ...declaration(), script: 'alert(1)' })).toBe(false)
    expect(isLegalUiCapabilityMetadata({ moduleRef: MODULE_REF, taskBindingRefs: [TASK_REF] })).toBe(false)
    expect(
      isLegalUiCapabilityMetadata({ ...declaration(), requiredCapabilities: ['data.readonly', 'data.readonly'] }),
    ).toBe(false)
    expect(isLegalUiCapabilityMetadata({ ...declaration(), moduleRef: { id: '', version: '1.0.0', digest: digest('d') } })).toBe(false)

    const mount = registered().mount({ ...declaration(), remoteUrl: 'https://example.invalid/module.js' }, {
      grantedCapabilities: ['data.readonly'],
    })
    expect(mount.kind).toBe('illegal_metadata')
  })

  it('falls back to the generic result when the moduleRef is not registered', () => {
    const mount = registered().mount(
      declaration({ moduleRef: { id: 'scene.neutral.unregistered', version: '1.0.0', digest: digest('e') } }),
      { grantedCapabilities: ['data.readonly'] },
    )
    expect(mount.kind).toBe('missing_module')
  })

  it('reports the exact missing capabilities', () => {
    const withBeta = new ScenarioModuleRegistry()
    withBeta.register({ ...module(), capabilityRequirements: ['data.readonly', 'pricing.compute'] })
    const mount = withBeta.mount(
      declaration({ requiredCapabilities: ['pricing.compute'] }),
      { grantedCapabilities: ['data.readonly'] },
    )
    expect(mount.kind).toBe('missing_capability')
    if (mount.kind !== 'missing_capability') throw new Error('expected missing capability')
    expect(mount.missing).toEqual(['pricing.compute'])
  })

  it('forbids a module outside the authorized set before resolving it', () => {
    const mount = registered().mount(declaration(), {
      grantedCapabilities: ['data.readonly'],
      allowedModuleRefs: [{ id: 'scene.neutral.beta', version: '1.0.0', digest: digest('f') }],
    })
    expect(mount.kind).toBe('forbidden')
  })
})
