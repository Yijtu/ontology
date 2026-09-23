import type { AppViewContribution } from '../components/App'
import { EnergyPlanPanel } from '../components/EnergyPlanPanel'

/** Deployment contribution: the shared App does not import or name home energy. */
export const HOME_ENERGY_VIEW: AppViewContribution = {
  view: 'energy',
  label: '家庭能源计划',
  render: ({ client, profileRef }) => <EnergyPlanPanel client={client} profileRef={profileRef} publishedExecutionRequired />,
}

/** Legacy fixture hosts can preview deterministic plans but cannot authorize execution. */
export const HOME_ENERGY_PREVIEW_VIEW: AppViewContribution = {
  view: 'energy',
  label: '家庭能源计划',
  render: ({ client, profileRef }) => <EnergyPlanPanel client={client} profileRef={profileRef} />,
}
