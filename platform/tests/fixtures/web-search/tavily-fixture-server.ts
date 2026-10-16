import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A controlled local fixture for the native Tavily adapter and the web-search connection probe
 * (SPEC C5; no live internet is ever used).
 *
 * It serves the Tavily `POST /search` shape on `/search` and a test page on any other path, and it
 * records every inbound search request (method, authorization header presence and parsed JSON body)
 * so a test can prove the adapter fixed `include_answer`/`auto_parameters`/`include_raw_content` and
 * sent exactly the approved `include_domains`. The canonical result URLs it returns are `https://`
 * values; only the transport to this fixture is plain HTTP.
 */
export interface TavilyFixtureResult {
  readonly url: string
  readonly title?: string
  readonly content: string
  readonly publishedDate?: string
  readonly score?: number
}

export interface TavilyFixtureScenario {
  readonly results?: readonly TavilyFixtureResult[]
  readonly answer?: string | null
  readonly responseTime?: number
  readonly credits?: number
  /** Non-2xx status to return instead of a search body. */
  readonly status?: number
  /** Delay before answering the search request, used to exercise the probe deadline. */
  readonly delayMs?: number
  /** Raw body override, used to exercise a malformed provider response. */
  readonly rawBody?: string
  /** Content type of the search response; override to exercise a non-JSON body. */
  readonly contentType?: string
  readonly retryAfter?: string
  /** When set, answer the search request with a 302 to this location (to prove redirects are refused). */
  readonly redirectTo?: string
  /** The HTML served for a GET page request (the probe's archive test page). */
  readonly pageHtml?: string
  /** Status served for a GET page request; override to exercise a broken test page. */
  readonly pageStatus?: number
}

export interface RecordedTavilyRequest {
  readonly method: string
  readonly path: string
  readonly authorizationPresent: boolean
  readonly body?: Record<string, unknown>
}

export interface TavilyFixture {
  readonly baseUrl: string
  readonly requests: RecordedTavilyRequest[]
  setScenario(scenario: TavilyFixtureScenario): void
  stop(): Promise<void>
}

export async function startTavilyFixture(): Promise<TavilyFixture> {
  let scenario: TavilyFixtureScenario = { results: [] }
  const requests: RecordedTavilyRequest[] = []

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/search') {
      servePage(request, response, scenario, requests)
      return
    }
    collect(request).then((raw) => {
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        authorizationPresent: request.headers.authorization !== undefined,
        ...(raw === undefined ? {} : { body: raw }),
      })
      const current = scenario
      const answer = (): void => {
        if (response.writableEnded || response.destroyed) return
        if (current.retryAfter !== undefined) response.setHeader('retry-after', current.retryAfter)
        if (current.redirectTo !== undefined) {
          response.writeHead(302, { location: current.redirectTo })
          response.end()
          return
        }
        if (current.status !== undefined && current.status >= 400) {
          response.writeHead(current.status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: `fixture status ${String(current.status)}` }))
          return
        }
        response.writeHead(200, { 'content-type': current.contentType ?? 'application/json' })
        response.end(current.rawBody ?? JSON.stringify(bodyFor(current)))
      }
      if (current.delayMs !== undefined && current.delayMs > 0) setTimeout(answer, current.delayMs)
      else answer()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    setScenario(next: TavilyFixtureScenario): void {
      scenario = next
    },
    stop: () => stopServer(server),
  }
}

function servePage(
  request: IncomingMessage,
  response: ServerResponse,
  scenario: TavilyFixtureScenario,
  requests: RecordedTavilyRequest[],
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  requests.push({
    method: request.method ?? 'GET',
    path: url.pathname,
    authorizationPresent: request.headers.authorization !== undefined,
  })
  const status = scenario.pageStatus ?? 200
  if (status >= 400) {
    response.writeHead(status, { 'content-type': 'text/plain' })
    response.end('page unavailable')
    return
  }
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(scenario.pageHtml ?? '<html><body><h1>Probe page</h1><p>Readable fragment.</p></body></html>')
}

function bodyFor(scenario: TavilyFixtureScenario): unknown {
  return {
    query: 'probe',
    follow_up_questions: null,
    answer: scenario.answer ?? null,
    images: [],
    results: (scenario.results ?? []).map((entry) => ({
      url: entry.url,
      title: entry.title ?? 'Result',
      content: entry.content,
      score: entry.score ?? 0.5,
      ...(entry.publishedDate === undefined ? {} : { published_date: entry.publishedDate }),
    })),
    response_time: scenario.responseTime ?? 1.5,
    ...(scenario.credits === undefined ? {} : { usage: { credits: scenario.credits } }),
  }
}

function collect(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * Route the adapter's absolute `https://` requests onto the local plain-HTTP fixture. The search
 * host is served by `/search` (POST) and the archive test-page host by `/test-page` (GET); anything
 * else is a 404, so a test can prove the adapter only talks to the hosts it was configured for.
 */
export function createFixtureFetch(
  fixture: TavilyFixture,
  searchHost = 'api.tavily.com',
  pageHost = 'docs.example.com',
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === searchHost) return fetch(`${fixture.baseUrl}/search`, init)
    if (url.hostname === pageHost) return fetch(`${fixture.baseUrl}/test-page`, init)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

