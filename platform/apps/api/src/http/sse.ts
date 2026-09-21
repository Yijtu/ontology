import type { PublicRunEvent } from '@ontology/application'

/**
 * Render one persisted public event as an SSE frame. The `id` is the durable, monotonically
 * increasing ledger sequence, so a browser `EventSource` reconnect sends it back as
 * `Last-Event-ID` and the server replays strictly after it; clients de-duplicate on the same
 * id. The payload is the sanitised public projection — no unverified draft text is ever
 * rendered here because no such event type exists on the public surface.
 */
export function formatSseFrame(event: PublicRunEvent): string {
  const payload = { ...event.data, occurredAt: event.occurredAt }
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}
