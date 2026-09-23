import type { ProfileRef } from '@ontology/contracts'
import type { AppViewContribution } from './components/App'
import type { QueryContextField } from './components/QueryPanel'
import { HOME_ENERGY_VIEW } from './scenarios/home-energy-view'

/** The existing home-energy demo is one deployment, not a framework default. */
const DEMO_PROFILE: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const ENERGY_QUERY_FIELDS: readonly QueryContextField[] = [
  { name: 'siteRef', label: '站点', kind: 'text' },
]

export interface WebDeployment {
  readonly profileRef: ProfileRef
  readonly timeZone: string
  readonly queryContextFields: readonly QueryContextField[]
  readonly scenarioViews: readonly AppViewContribution[]
}

/** Other deployments replace this assembly with their own profile and view contributions. */
export function resolveWebDeployment(params: URLSearchParams): WebDeployment {
  const id = params.get('profileId')
  const version = params.get('profileVersion')
  if (id === null && version === null) {
    return { profileRef: DEMO_PROFILE, timeZone: 'Asia/Shanghai', queryContextFields: ENERGY_QUERY_FIELDS, scenarioViews: [HOME_ENERGY_VIEW] }
  }
  if (id === null || id.trim() === '' || version === null || version.trim() === '') {
    throw new Error('profileId and profileVersion must be supplied together')
  }
  return {
    profileRef: { id, version },
    timeZone: params.get('timeZone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    queryContextFields: id === DEMO_PROFILE.id && version === DEMO_PROFILE.version ? ENERGY_QUERY_FIELDS : [],
    scenarioViews: id === DEMO_PROFILE.id && version === DEMO_PROFILE.version ? [HOME_ENERGY_VIEW] : [],
  }
}
