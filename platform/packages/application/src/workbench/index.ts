/**
 * The knowledge-workbench overview surface (design §2.2/§2.4/§2.5, A-R01).
 *
 * `WorkbenchOverviewService` derives a deterministic, fixed-revision read-only projection from
 * persisted state; it never guesses a todo and never becomes a new approval truth.
 */
export {
  WorkbenchOverviewService,
  deriveWorkspaceSteps,
  deriveProjectSteps,
  deriveSpaceSteps,
} from './workbench-overview-service'
export type { WorkbenchOverviewServiceDependencies } from './workbench-overview-service'
