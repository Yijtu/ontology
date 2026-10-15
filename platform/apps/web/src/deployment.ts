import type { ProfileRef } from '@ontology/contracts'
import type { AppViewContribution } from './components/App'
import type { QueryContextField } from './components/QueryPanel'
import { HOME_ENERGY_VIEW } from './scenarios/home-energy-view'

export interface WebDeployment {
  readonly profileRef: ProfileRef
  readonly timeZone: string
  readonly queryContextFields: readonly QueryContextField[]
  readonly scenarioViews: readonly AppViewContribution[]
}

/**
 * Explicit build-time registration of deployment profile → scenario views and query context
 * fields. This replaces an inline industry-name branch: the shared App never names a scenario,
 * it receives whatever the composition registered for the requested profile.
 */
interface ScenarioViewRegistration {
  readonly profileRef: ProfileRef
  readonly queryContextFields: readonly QueryContextField[]
  readonly views: readonly AppViewContribution[]
}

const SCENARIO_VIEW_REGISTRATIONS: readonly ScenarioViewRegistration[] = [
  {
    profileRef: { id: 'home-energy-demo', version: '1.0.0' },
    queryContextFields: [{ name: 'siteRef', label: '站点', kind: 'text' }],
    views: [HOME_ENERGY_VIEW],
  },
]

function registrationFor(id: string, version: string): ScenarioViewRegistration | undefined {
  return SCENARIO_VIEW_REGISTRATIONS.find(
    (registration) => registration.profileRef.id === id && registration.profileRef.version === version,
  )
}

/** Explicit non-Core deployments may supply a profile through the URL. Core metadata is loaded from the API. */
export function resolveWebDeployment(params: URLSearchParams): WebDeployment {
  const id = params.get('profileId')
  const version = params.get('profileVersion')
  if (id === null || id.trim() === '' || version === null || version.trim() === '') {
    throw new Error('profileId and profileVersion must be supplied together')
  }
  const registration = registrationFor(id, version)
  return {
    profileRef: { id, version },
    timeZone: params.get('timeZone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    queryContextFields: registration?.queryContextFields ?? [],
    scenarioViews: registration?.views ?? [],
  }
}
