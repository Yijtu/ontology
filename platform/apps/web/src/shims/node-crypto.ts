/**
 * Browser shim for `node:crypto` (SPEC v0.3a execution-evidence §EX-7.1).
 *
 * The shared `@ontology/contracts` barrel re-exports `typed-results.ts`, whose digest helpers are
 * implemented with `node:crypto`'s `createHash`. `apps/web` imports runtime guards from the same
 * barrel, so Vite would otherwise externalise `node:crypto` and fail the browser build. The digest
 * helpers are never called in the browser (the web bundle uses Web Crypto via
 * `webWorkspaceIdentity`), so this shim keeps the module resolvable and fails loudly if a browser
 * path ever tries to compute a canonical digest where it must not.
 */
export function createHash(): never {
  throw new Error('node:crypto.createHash is not available in the browser bundle; digest helpers run server-side')
}
