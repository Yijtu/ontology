import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Principal, ScopeRef } from '@ontology/contracts'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

/**
 * Deployment-level bearer token authentication (design §4, phase A1).
 *
 * The server currently only accepts the loopback development principal, so a client on another
 * machine can never authenticate. This is the smallest honest step: one deployment token, mapped to
 * the configured tenant/space and a fixed role set. It is **not** multi-user authentication — whoever
 * holds the token gets the whole scope — so a deployment exposed beyond a trusted network must move
 * to OIDC (phase A2).
 *
 * The comparison hashes both sides first and uses a constant-time compare, so neither the length nor
 * an early mismatch leaks the token through timing.
 */
export interface BearerTokenAuthenticatorOptions {
  readonly token: string
  readonly scopeRef: ScopeRef
  readonly roles: readonly string[]
  readonly subjectId: string
  readonly authEpoch?: number
}

const BEARER_PREFIX = /^Bearer +/iu

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digestOf(presented), digestOf(expected))
}

function presentedToken(request: FastifyRequest): string | undefined {
  const raw = request.headers?.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !BEARER_PREFIX.test(value)) return undefined
  const token = value.replace(BEARER_PREFIX, '').trim()
  return token.length === 0 ? undefined : token
}

export function createBearerTokenAuthenticator(
  options: BearerTokenAuthenticatorOptions,
): RequestAuthenticator {
  if (options.token.length === 0) throw new Error('a deployment token must not be empty')
  const principal: Principal = Object.freeze({
    tenantId: options.scopeRef.tenantId,
    subjectId: options.subjectId,
    roles: [...options.roles],
    scopes: [],
    authEpoch: options.authEpoch ?? 1,
  })
  return (request: FastifyRequest): AuthenticatedRequest | undefined => {
    const token = presentedToken(request)
    if (token === undefined) return undefined
    if (!tokenMatches(token, options.token)) return undefined
    return { principal, spaceId: options.scopeRef.spaceId }
  }
}

/**
 * Security headers for every response (design §4/§6).
 *
 * The Electron client loads this UI from a remote origin, so the page runs with the privileges of a
 * desktop shell. A restrictive CSP plus no-sniff/no-referrer is the baseline that keeps a compromised
 * or unexpected script from going further than a plain page.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React/Vite emit some inline style attributes; nothing else needs a relaxation.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    return payload
  })
}

/**
 * Serve the built web app from the API origin (design §4).
 *
 * The client loads this exact UI, so it is same-origin with the API: no CORS relaxation is needed.
 * Only real files are served by the static handler; a GET outside `/api` and `/healthz` that names no
 * file falls back to `index.html`, which is what a client-side route needs. Unknown API paths still
 * get a 404 instead of the SPA shell, so a typo in an endpoint never looks like a working page.
 *
 * `index.html` is never cached (it names hashed assets and must follow a deploy), while hashed assets
 * under `/assets/` are immutable.
 */
export interface WebAppOptions {
  readonly root: string
}

export function registerWebApp(app: FastifyInstance, options: WebAppOptions): void {
  const root = resolve(options.root)
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(`the web build at ${root} has no index.html; run "pnpm run build:web" first`)
  }
  app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders: (response, path) => {
      const immutable = path.startsWith(resolve(root, 'assets'))
      response.header(
        'cache-control',
        immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
    },
  })
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/') || request.url.startsWith('/healthz')) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'the requested resource does not exist', retryable: false },
      })
    }
    reply.header('cache-control', 'no-cache')
    return reply.type('text/html; charset=utf-8').sendFile('index.html')
  })
}
