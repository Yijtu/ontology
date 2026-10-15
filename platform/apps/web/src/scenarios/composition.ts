import { ScenarioModuleRegistry } from '../mount/registry'
import { NEUTRAL_SCENARIO_MODULES } from './synthetic/neutral-scenario-modules'

/**
 * Scenario composition entry (SPEC v0.3a §9.3, A-ADR-09). The trusted web build registers the
 * compiled modules it ships here; API deployment metadata and industry packs only reference a
 * moduleRef. Adding a scenario means registering a module or changing a declaration — the public
 * shell is never edited and never branches on an industry name.
 *
 * The neutral modules are the two isolated test scenario mounts A ships for the mount contract;
 * a later change registers the professional modules the same way.
 */
export function registerBuiltInScenarioModules(registry: ScenarioModuleRegistry): ScenarioModuleRegistry {
  for (const module of NEUTRAL_SCENARIO_MODULES) {
    registry.register(module)
  }
  return registry
}

export function createScenarioRegistry(): ScenarioModuleRegistry {
  return registerBuiltInScenarioModules(new ScenarioModuleRegistry())
}
