/**
 * @ontology/contracts — canonical cross-process contracts (INV-01).
 *
 * This package contains only data types, JSON Schema, version and error definitions.
 * It imports no SDK, database, HTTP or industry package. The TypeScript types are
 * generated from `schema/*.schema.json`; `pnpm --filter @ontology/contracts run
 * check:contracts` fails when the committed output drifts from the canonical schema.
 */
export * from './generated/contracts'
export * from './generated/schema-bundle'
export * from './generated/tool-catalogue'
export * from './generated/error-catalogue'
export * from './ports'
export * from './budget'
export * from './component-registry'
export * from './profile-store'
export * from './source-bindings'
export * from './web-search'
export * from './run-store'
export * from './job-store'
export * from './document-parse'
export * from './evidence-store'
export * from './trusted'
export * from './operations'
export * from './semver'
export * from './industry-packs'
export * from './preflight'
