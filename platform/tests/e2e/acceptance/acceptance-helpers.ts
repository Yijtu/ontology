import { randomUUID } from 'node:crypto'
import type { ResourceRef, VersionRef } from '@ontology/contracts'
import { encodeDocumentIngestionRef } from '@ontology/application'
import { PI_PROFILE, PI_RUNTIME_REF } from './acceptance-environment'
import type { AcceptanceEnvironment, AcceptanceScope } from './acceptance-environment'

type App = AcceptanceEnvironment['app']
import {
  PROFILE,
  TELEMETRY_ADAPTER_REF,
  mappingRef,
  sampleProfileSpec,
} from '../../ui/workbench-fixtures'

/**
 * Thin HTTP helpers for the acceptance suite. They only build request envelopes and read
 * JSON back; every assertion lives in the spec so the real API response is what is checked.
 */

export interface InjectResult {
  readonly status: number
  readonly body: unknown
}

export function jsonHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'content-type': 'application/json', ...extra }
}

export async function injectJson(
  app: App,
  method: 'GET' | 'POST',
  url: string,
  options: { readonly payload?: Record<string, unknown>; readonly headers?: Record<string, string> } = {},
): Promise<InjectResult> {
  const headers = options.headers ?? {}
  const response = await app.inject({
    method,
    url,
    headers: options.payload === undefined ? headers : jsonHeaders(headers),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  })
  return { status: response.statusCode, body: response.json() as unknown }
}

export function dataOf<T>(result: InjectResult): T {
  return (result.body as { data: T }).data
}

export function errorCodeOf(result: InjectResult): string {
  return (result.body as { error: { code: string } }).error.code
}

/**
 * The configuration phase: publish the profile, register and probe the source, then
 * preflight and activate — all through the real HTTP surface, exactly as the workbench UI
 * does. Returns the resolved snapshot hash the run binds to.
 */
export async function configureProfile(env: AcceptanceEnvironment): Promise<{ snapshotHash: string }> {
  const published = await injectJson(env.app, 'POST', '/api/v1/profiles', {
    headers: { 'idempotency-key': `acceptance-profile-${randomUUID()}` },
    payload: { profileRef: PROFILE, spec: sampleProfileSpec(), environment: 'local_dev' },
  })
  if (published.status !== 201) throw new Error(`profile publish failed: ${published.status}`)

  const source = await injectJson(env.app, 'POST', '/api/v1/sources', {
    headers: { 'idempotency-key': `acceptance-source-${randomUUID()}` },
    payload: {
      kind: 'read_only_origin',
      role: 'telemetry',
      adapterRef: TELEMETRY_ADAPTER_REF,
      secretRef: 'secret://vault/telemetry',
      mappingRef: mappingRef('telemetry'),
      capabilityVersion: '1.0.0',
    },
  })
  if (source.status !== 201) throw new Error(`source registration failed: ${source.status}`)
  const sourceId = dataOf<{ sourceId: string }>(source).sourceId

  const probed = await injectJson(env.app, 'POST', `/api/v1/sources/${sourceId}/probe`)
  if (probed.status !== 200) throw new Error(`source probe failed: ${probed.status} ${JSON.stringify(probed.body)}`)

  const preflight = await injectJson(env.app, 'POST', `/api/v1/profiles/${PROFILE.id}/preflight`, {
    payload: { version: PROFILE.version },
  })
  if (preflight.status !== 200) throw new Error(`preflight failed: ${preflight.status}`)
  const snapshotHash = dataOf<{ resolvedProfile?: { snapshotHash: string } }>(preflight).resolvedProfile
    ?.snapshotHash
  if (snapshotHash === undefined) throw new Error('preflight did not resolve a snapshot hash')

  const activated = await injectJson(env.app, 'POST', `/api/v1/profiles/${PROFILE.id}/activate`, {
    headers: { 'if-match': '*' },
    payload: { version: PROFILE.version, snapshotHash },
  })
  if (activated.status !== 200) throw new Error(`activation failed: ${activated.status}`)
  return { snapshotHash }
}

/** Publish a second profile (the Pi runtime) so the matrix leg binds it for real. */
export async function publishPiProfile(env: AcceptanceEnvironment): Promise<void> {
  const published = await injectJson(env.app, 'POST', '/api/v1/profiles', {
    headers: { 'idempotency-key': `acceptance-pi-profile-${randomUUID()}` },
    payload: {
      profileRef: PI_PROFILE,
      spec: sampleProfileSpec({ runtimeRef: PI_RUNTIME_REF }),
      environment: 'local_dev',
    },
  })
  if (published.status !== 201) throw new Error(`pi profile publish failed: ${published.status}`)
}

export async function publishOriginal(
  env: AcceptanceEnvironment,
  text: string,
  mediaType = 'text/plain',
): Promise<ResourceRef> {
  const scope = env.scope
  const bytes = new TextEncoder().encode(text)
  const staged = await env.blobStore.stage(bytes, { scopeRef: scope.scopeRef }, scope.ctx)
  const published = await env.blobStore.publish(
    {
      scopeRef: scope.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    scope.ctx,
  )
  return published.blobRef
}

export interface IngestionResult {
  readonly jobId: string
  readonly stage: string
  readonly processed: number
  readonly documentRef: string | undefined
}

/** Create an ingestion job through the real API and drain it with the real worker. */
export async function ingestDocument(
  env: AcceptanceEnvironment,
  text: string,
  mediaType = 'text/plain',
): Promise<IngestionResult> {
  const originalRef = await publishOriginal(env, text, mediaType)
  const documentRef = encodeDocumentIngestionRef({
    kind: 'document_ingestion',
    originalRef,
    parserVersion: '1.0.0',
    definitionRef: env.definitionRef(),
  })
  const created = await injectJson(env.app, 'POST', '/api/v1/ingestions', {
    headers: { 'idempotency-key': `acceptance-ingest-${randomUUID()}` },
    payload: { sourceRef: 'acceptance-source', documentRef, pipelineVersion: '1.0.0' },
  })
  if (created.status !== 202) throw new Error(`ingestion create failed: ${created.status}`)
  const jobId = dataOf<{ jobId: string }>(created).jobId

  await env.worker().runUntilIdle(env.scope.scopeRef, env.scope.ctx)

  const view = await injectJson(env.app, 'GET', `/api/v1/jobs/${jobId}`)
  if (view.status !== 200) throw new Error(`job read failed: ${view.status}`)
  const job = dataOf<{ stage: string; counts: { processed: number }; documentRef?: string }>(view)
  return { jobId, stage: job.stage, processed: job.counts.processed, documentRef: job.documentRef }
}

export function definitionRef(env: AcceptanceEnvironment): VersionRef {
  return env.definitionRef()
}

export type { AcceptanceScope }
