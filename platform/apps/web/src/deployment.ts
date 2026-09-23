import type { ProfileRef } from '@ontology/contracts'
import type { AppViewContribution } from './components/App'
import { HOME_ENERGY_VIEW } from './scenarios/home-energy-view'

/** Profiles are deployment configuration; the shared UI does not know their industry fields. */
const DEMO_PROFILE: ProfileRef = { id: 'home-energy-demo-wide', version: '1.0.0' }
const PROFILE_OPTIONS = [
  { profileRef: DEMO_PROFILE, label: '能源 A：宽表遥测' },
  { profileRef: { id: 'home-energy-demo-long', version: '1.0.0' }, label: '能源 B：长表 metric-code' },
  { profileRef: { id: 'transport-government-local', version: '1.0.0' }, label: '交通：设施巡检' },
  { profileRef: { id: 'local-policy-documents', version: '1.0.0' }, label: '文档：政策引文' },
] as const

export interface WebDeployment {
  readonly profileRef: ProfileRef
  readonly timeZone: string
  readonly scenarioViews: readonly AppViewContribution[]
  readonly profileOptions: typeof PROFILE_OPTIONS
}

/** Other deployments replace this assembly with their own profile and view contributions. */
export function resolveWebDeployment(params: URLSearchParams): WebDeployment {
  const id = params.get('profileId')
  const version = params.get('profileVersion')
  if (id === null && version === null) {
    return { profileRef: DEMO_PROFILE, timeZone: 'UTC', scenarioViews: [HOME_ENERGY_VIEW], profileOptions: PROFILE_OPTIONS }
  }
  if (id === null || id.trim() === '' || version === null || version.trim() === '') {
    throw new Error('profileId and profileVersion must be supplied together')
  }
  return {
    profileRef: { id, version },
    timeZone: params.get('timeZone') ?? 'UTC',
    scenarioViews: id === DEMO_PROFILE.id || id === 'home-energy-demo-long' ? [HOME_ENERGY_VIEW] : [],
    profileOptions: PROFILE_OPTIONS,
  }
}
