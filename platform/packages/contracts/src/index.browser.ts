/**
 * Browser entry point for `@ontology/contracts`.
 *
 * It exposes every data type, port and runtime guard a browser bundle needs, but deliberately
 * omits `typed-results-digest.ts` so `node:crypto` (and Node's `Buffer`) are never pulled into
 * a browser build. The web app reads verified results through the HTTP client and re-validates
 * wire shapes with local guards; it never computes a canonical digest itself.
 */
export * from './public-api'
