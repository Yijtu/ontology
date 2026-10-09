import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ProfileRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import type { CreateRunRequest, RunEventStream } from '../../api/query'
import { ApiError } from '../../api/errors'
import { initialQueryState, queryReducer } from '../../state/query'
import type { QueryEvent, QueryState } from '../../state/query'
import type { WorkbenchError } from '../../state/workbench'
import { useRequestFence } from './useRequestFence'

function failure(error: unknown): QueryEvent {
  const api = error instanceof ApiError ? error : undefined
  const detail: WorkbenchError = {
    code: api?.code ?? 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : '请求无法完成。',
    ...(api?.traceId === undefined ? {} : { traceId: api.traceId }),
    ...(api === undefined || api.reasons.length === 0 ? {} : { reasons: api.reasons }),
  }
  return {
    type:
      api?.permissionDenied === true
        ? 'permissionDenied'
        : api?.code === 'CAPABILITY_NOT_CONFIGURED'
          ? 'notConfigured'
          : 'failed',
    error: detail,
  }
}
const terminal = (state: string) => ['published', 'cancelled', 'failed', 'blocked'].includes(state)
type Ticket = ReturnType<ReturnType<typeof useRequestFence>>

/** A session fences HTTP and SSE together. Cancellation invalidates in-flight answer reads. */
export function useRunSession(
  client: WorkbenchClient,
  profileRef: ProfileRef,
  initialRunId?: string,
  projectKey = '',
) {
  const key = useMemo(
    () => ({ client, id: profileRef.id, version: profileRef.version, initialRunId, projectKey }),
    [client, profileRef.id, profileRef.version, initialRunId, projectKey],
  )
  const begin = useRequestFence(key)
  const [stored, dispatch] = useReducer(queryReducer, undefined, initialQueryState)
  const owner = useRef(key)
  const state: QueryState = owner.current === key ? stored : initialQueryState()
  const stateRef = useRef(state)
  stateRef.current = state
  const stream = useRef<RunEventStream | undefined>(undefined)
  const active = useRef<{ ticket: Ticket; runId: string; cancelled: boolean } | undefined>(undefined)
  const submitting = useRef(false)
  const retainedSubmission = useRef<{ serialized: string; key: string } | undefined>(undefined)
  const restoredInitial = useRef<{ client: WorkbenchClient; runId: string; projectKey: string } | undefined>(
    undefined,
  )

  const closeStream = useCallback(() => {
    stream.current?.close()
    stream.current = undefined
  }, [])
  const loadAnswer = useCallback(
    async (runId: string, ticket: Ticket) => {
      const read = begin('answer')
      try {
        const result = await client.getAnswer(runId)
        if (result.kind === 'published' && result.answer.runId !== runId)
          throw new Error('答案与当前运行不一致。')
        if (
          ticket.current() &&
          read.current() &&
          active.current?.runId === runId &&
          !active.current.cancelled
        )
          dispatch({ type: 'answerLoaded', runId, result })
      } catch (error) {
        if (ticket.current() && read.current() && !active.current?.cancelled) dispatch(failure(error))
      }
    },
    [begin, client],
  )
  const refreshRun = useCallback(
    async (runId: string, ticket: Ticket) => {
      const read = begin('run-read')
      try {
        const run = await client.getRun(runId)
        if (
          ticket.current() &&
          read.current() &&
          active.current?.runId === runId &&
          !active.current.cancelled
        )
          dispatch({ type: 'runLoaded', run })
      } catch (error) {
        if (ticket.current() && read.current() && !active.current?.cancelled) dispatch(failure(error))
      }
    },
    [begin, client],
  )
  const adopt = useCallback(
    async (runId: string, ticket: Ticket, createdHere = false) => {
      const run = await client.getRun(runId)
      if (!ticket.current()) return
      if (
        run.runId !== runId ||
        (createdHere &&
          (run.profileRef.id !== profileRef.id || run.profileRef.version !== profileRef.version))
      )
        throw new Error('运行与当前场景不一致。')
      active.current = { runId, ticket, cancelled: run.state === 'cancelled' || run.state === 'cancelling' }
      dispatch({ type: 'runLoaded', run })
      if (active.current.cancelled) return
      void loadAnswer(runId, ticket)
      if (terminal(run.state)) return
      closeStream()
      stream.current = client.openRunEvents(runId, undefined, {
        onOpen: () => {
          if (ticket.current() && !active.current?.cancelled) dispatch({ type: 'streamState', state: 'open' })
        },
        onError: () => {
          if (ticket.current() && !active.current?.cancelled)
            dispatch({ type: 'streamState', state: 'error' })
        },
        onEvent: (event) => {
          if (!ticket.current() || active.current?.runId !== runId || active.current.cancelled) return
          dispatch({ type: 'runEvents', events: [event] })
          if (event.event === 'run.state') {
            if (event.data['state'] === 'cancelled' || event.data['state'] === 'cancelling') {
              active.current.cancelled = true
              closeStream()
              void client
                .getRun(runId)
                .then((current) => {
                  if (!ticket.current()) return
                  if (current.state !== 'cancelled' && current.state !== 'cancelling')
                    throw new Error('取消事件与服务端运行状态不一致，请核对当前状态。')
                  dispatch({ type: 'cancelled', run: current })
                })
                .catch((error: unknown) => {
                  if (ticket.current()) dispatch(failure(error))
                })
            } else void refreshRun(runId, ticket)
          }
          if (event.event === 'answer.published' || event.event === 'run.failed') {
            closeStream()
            void loadAnswer(runId, ticket)
            void refreshRun(runId, ticket)
          }
        },
      })
    },
    [client, profileRef.id, profileRef.version, loadAnswer, refreshRun, closeStream],
  )
  const reloadScope = useCallback(async () => {
    const ticket = begin('scope')
    dispatch({ type: 'scopeLoadStarted' })
    try {
      const scope = await client.getRunScope(profileRef)
      if (ticket.current()) dispatch({ type: 'scopeLoaded', scope })
    } catch (error) {
      if (ticket.current()) dispatch(failure(error))
    }
  }, [begin, client, profileRef.id, profileRef.version])

  useEffect(() => {
    owner.current = key
    active.current = undefined
    submitting.current = false
    retainedSubmission.current = undefined
    dispatch({ type: 'reset' })
    closeStream()
    const ticket = begin('session')
    void (async () => {
      await reloadScope()
      if (initialRunId === undefined) restoredInitial.current = undefined
      const prior = restoredInitial.current
      const requestedRestore =
        initialRunId !== undefined &&
        (prior === undefined ||
          prior.client !== client ||
          prior.runId !== initialRunId ||
          prior.projectKey === projectKey)
      if (ticket.current() && initialRunId !== undefined && requestedRestore) {
        try {
          await adopt(initialRunId, ticket)
          if (ticket.current()) restoredInitial.current = { client, runId: initialRunId, projectKey }
        } catch (error) {
          if (ticket.current()) dispatch(failure(error))
        }
      }
    })()
    return closeStream
  }, [key, begin, reloadScope, initialRunId, adopt, closeStream, client, projectKey])

  const create = async (request: CreateRunRequest) => {
    if (submitting.current) return
    submitting.current = true
    closeStream()
    const ticket = begin('session')
    active.current = undefined
    dispatch({ type: 'askStarted' })
    const serialized = JSON.stringify(request)
    if (retainedSubmission.current?.serialized !== serialized)
      retainedSubmission.current = { serialized, key: client.newRequestKey() }
    try {
      const created = await client.createRun(request, retainedSubmission.current.key)
      if (!ticket.current()) return
      await adopt(created.runId, ticket, true)
      if (ticket.current()) retainedSubmission.current = undefined
    } catch (error) {
      if (ticket.current()) dispatch(failure(error))
    } finally {
      if (ticket.current()) submitting.current = false
    }
  }
  const respond = async (typedResponse: Readonly<Record<string, unknown>>) => {
    const run = stateRef.current.run,
      clarification = stateRef.current.clarification,
      session = active.current
    if (
      run === undefined ||
      clarification === undefined ||
      session === undefined ||
      session.cancelled ||
      stateRef.current.busy
    )
      return false
    dispatch({ type: 'busy' })
    try {
      await client.respondToClarification(run.runId, {
        clarificationId: clarification.clarificationId,
        typedResponse,
        expectedRevision: run.revision,
      })
      if (!session.ticket.current() || session.cancelled) return false
      dispatch({ type: 'clarificationAnswered' })
      await refreshRun(run.runId, session.ticket)
      void loadAnswer(run.runId, session.ticket)
      return true
    } catch (error) {
      if (session.ticket.current() && !session.cancelled) dispatch(failure(error))
      return false
    }
  }
  const cancel = async () => {
    const run = stateRef.current.run,
      session = active.current
    if (run === undefined || session === undefined || session.cancelled || terminal(run.state)) return
    // Fence first, before either asynchronous cancel write or readback can finish.
    session.cancelled = true
    closeStream()
    dispatch({ type: 'busy' })
    try {
      await client.cancelRun(run.runId, { reason: '用户取消', expectedRevision: run.revision })
      const refreshed = await client.getRun(run.runId)
      if (!session.ticket.current()) return
      if (refreshed.state !== 'cancelled' && refreshed.state !== 'cancelling')
        throw new Error('服务端尚未确认取消，请刷新该运行状态。')
      dispatch({ type: 'cancelled', run: refreshed })
    } catch (error) {
      if (session.ticket.current()) dispatch(failure(error))
    }
  }
  const recover = async () => {
    const runId = active.current?.runId ?? stateRef.current.run?.runId ?? initialRunId
    const ticket = begin('session')
    closeStream()
    active.current = undefined
    dispatch({ type: 'restoreStarted' })
    try {
      if (runId === undefined) await reloadScope()
      else await adopt(runId, ticket)
    } catch (error) {
      if (ticket.current()) dispatch(failure(error))
    }
  }
  return { state, dispatch, create, respond, cancel, reloadScope, recover }
}
