import type { AppViewContribution } from '../components/App'
import { EnergyPlanPanel } from '../components/EnergyPlanPanel'

/** Deployment contribution: the shared App does not import or name home energy. */
export const HOME_ENERGY_VIEW: AppViewContribution = {
  view: 'energy',
  label: '家庭能源计划',
  render: ({ client }) => <EnergyPlanPanel client={client} />,
}
