/**
 * Node entry point for `@ontology/contracts`.
 *
 * It re-exports the browser-safe public API plus the Node-only typed-result digest/cursor
 * helpers (the only `node:crypto` usage in the package). A browser bundle resolves
 * `index.browser.ts` (via the package `exports.browser` condition) and therefore never pulls
 * `node:crypto`.
 */
export * from './public-api'
export * from './typed-results-digest'
