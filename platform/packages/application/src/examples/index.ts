/**
 * Few-shot example retrieval (LOCAL-076).
 *
 * The module resolves versioned example sets, retrieves declared examples through the
 * injected `DocumentSearchPort`, and renders them as untrusted data for the generation
 * request. It depends only on `@ontology/contracts`; the real search backend is injected
 * by the composition root, so the application layer never imports an adapter.
 */
export { FewShotExampleError, isFewShotExampleError } from './errors'
export type { FewShotExampleErrorCode } from './errors'
export {
  DEFAULT_FEW_SHOT_TOP_K,
  FEW_SHOT_UNTRUSTED_HEADER,
  FewShotExampleRetriever,
  MAX_FEW_SHOT_TOP_K,
  renderFewShotExamplesData,
} from './few-shot-retriever'
export type {
  FewShotExampleProvider,
  FewShotRetrievalRequest,
  FewShotRetrievalResult,
  FewShotRetrievalStatus,
  FewShotRetrieverDependencies,
  FewShotSourceRef,
  FewShotWarning,
  RetrievedFewShotExample,
} from './few-shot-retriever'
