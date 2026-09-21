/**
 * Server-sent-events reader for the company stream.
 *
 * It yields only the `data:` payloads and stops at the `[DONE]` sentinel. The abort
 * signal is the fetch signal, so an abort/timeout rejects the pending `reader.read()`
 * and the generator terminates instead of hanging.
 */
export async function* iterateSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).endsWith('\r')
          ? buffer.slice(0, newline - 1)
          : buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const payload = dataOf(line)
        if (payload === '[DONE]') return
        if (payload !== undefined) yield payload
        newline = buffer.indexOf('\n')
      }
    }
    const tail = dataOf(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
    if (tail !== undefined && tail !== '[DONE]') yield tail
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The body may already be errored/closed by an abort; nothing left to release.
    }
  }
}

function dataOf(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  const value = line.slice('data:'.length)
  return value.startsWith(' ') ? value.slice(1) : value
}
