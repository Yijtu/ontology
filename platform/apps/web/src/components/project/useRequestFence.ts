import { useCallback, useEffect, useMemo, useRef } from 'react'

/** Each read belongs to one selected scope and one request in its channel. */
export function useRequestFence(scopeKey: unknown) {
  const scope = useRef(scopeKey)
  const channels = useMemo(() => new Map<string, AbortController>(), [scopeKey])
  scope.current = scopeKey
  useEffect(() => {
    return () => {
      for (const controller of channels.values()) controller.abort()
      channels.clear()
    }
  }, [channels])
  return useCallback(
    (channel: string) => {
      channels.get(channel)?.abort()
      const controller = new AbortController()
      channels.set(channel, controller)
      const selectedScope = scopeKey
      return {
        signal: controller.signal,
        current: () =>
          !controller.signal.aborted &&
          scope.current === selectedScope &&
          channels.get(channel) === controller,
      }
    },
    [scopeKey, channels],
  )
}
