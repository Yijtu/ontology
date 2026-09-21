/**
 * D6 pipeline state machine. The invariants live in `@ontology/contracts` (next to the stage
 * type and the `JobStore` port) so both the application worker and the database adapter apply
 * the same rules. This module re-exports them for the application layer's public surface.
 */
export {
  canAdvanceJobStage,
  isRetryableStage,
  isTerminalJobStage,
  nextPipelineStage,
} from '@ontology/contracts'
