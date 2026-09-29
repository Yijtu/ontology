/**
 * @ontology/core — pure policy and arithmetic shared by every layer.
 *
 * This package depends only on `@ontology/contracts`. It imports no SDK, driver,
 * network protocol or industry package; persistence arrives through injected ports.
 */
export * from './budget'
export * from './decimal'
export * from './rule-conclusion'
