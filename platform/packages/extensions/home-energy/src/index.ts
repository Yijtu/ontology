/**
 * `@ontology/extension-home-energy` — the executable home-energy domain (SPEC E1–E4).
 *
 * It owns pure energy domain models, normalisation and (later) planning/simulation. It imports
 * `@ontology/contracts` only: no SDK, no database driver, no runtime and no MCP transport. Every
 * capability it needs — telemetry reads, declared conversions and the immutable artifact writer —
 * arrives by construction injection.
 */
export * from './input'
export * from './simulation'
