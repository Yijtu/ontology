import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A controlled local search fixture (SPEC C5; no live internet is ever used).
 *
 * It records every inbound request so a test can prove that disabling web access emits
 * zero provider requests, and it lets a test script the response for the timeout, error,
 * truncation, empty and prompt-injection cases. The canonical page URLs it returns are
 * `https://` values; only the transport to this fixture is plain HTTP.
 */
export interface FixturePage {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly content: string
  readonly publishedAt?: string
}

export interface FixtureScenario {
  readonly results: readonly FixturePage[]
  readonly truncated?: boolean
  readonly nextCursor?: string | null
  readonly total?: number
  /** Non-2xx status to return instead of a body. */
  readonly status?: number
  /** Delay before answering, used to exercise the propagated deadline. */
  readonly delayMs?: number
  /** Raw body override, used to exercise a malformed provider response. */
  readonly rawBody?: string
  readonly retryAfter?: string
}

export interface RecordedSearchRequest {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly domains: readonly string[]
  readonly freshness?: string
  readonly limit?: string
  readonly cursor?: string
}

export interface WebSearchFixture {
  readonly baseUrl: string
  readonly requests: RecordedSearchRequest[]
  setScenario(scenario: FixtureScenario): void
  stop(): Promise<void>
}

export async function startWebSearchFixture(): Promise<WebSearchFixture> {
  let scenario: FixtureScenario = { results: [] }
  const requests: RecordedSearchRequest[] = []

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/v1/search') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    requests.push(record(request, url))
    const current = scenario
    const answer = (): void => {
      if (response.writableEnded || response.destroyed) return
      if (current.retryAfter !== undefined) response.setHeader('retry-after', current.retryAfter)
      if (current.status !== undefined && current.status >= 400) {
        response.writeHead(current.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: `fixture status ${String(current.status)}` }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(current.rawBody ?? JSON.stringify(bodyFor(current)))
    }
    if (current.delayMs !== undefined && current.delayMs > 0) {
      setTimeout(answer, current.delayMs)
    } else {
      answer()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    setScenario(next: FixtureScenario): void {
      scenario = next
    },
    stop: () => stopServer(server),
  }
}

function record(request: IncomingMessage, url: URL): RecordedSearchRequest {
  const domains = (url.searchParams.get('domains') ?? '').split(',').filter((entry) => entry.length > 0)
  const freshness = url.searchParams.get('freshness')
  const limit = url.searchParams.get('limit')
  const cursor = url.searchParams.get('cursor')
  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams.get('query') ?? '',
    domains,
    ...(freshness === null ? {} : { freshness }),
    ...(limit === null ? {} : { limit }),
    ...(cursor === null ? {} : { cursor }),
  }
}

function bodyFor(scenario: FixtureScenario): unknown {
  return {
    results: scenario.results.map((page) => ({
      url: page.url,
      title: page.title,
      snippet: page.snippet,
      content: page.content,
      ...(page.publishedAt === undefined ? {} : { publishedAt: page.publishedAt }),
    })),
    truncated: scenario.truncated === true,
    nextCursor: scenario.nextCursor ?? null,
    ...(scenario.total === undefined ? {} : { total: scenario.total }),
  }
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}
