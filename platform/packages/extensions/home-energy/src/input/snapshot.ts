import { createHash } from 'node:crypto'
import { isToolContext } from '@ontology/contracts'
import type {
  ImmutableArtifactWriter,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import { EnergyInputError } from './errors'
import type { EnergyInputManifest, EnergyInputSnapshot, NormalizedEnergyInput } from './types'

/**
 * Immutable, content-addressed input snapshot (ADR-08, C3.1).
 *
 * The normalised input is serialised to canonical JSON (sorted keys, `undefined` dropped) and
 * archived through the injected `ImmutableArtifactWriter`. The adapter derives the object key
 * from the content digest, so the same inputs always reproduce the same snapshot digest and a
 * retry is idempotent. The extension holds no filesystem handle and no connection string.
 */

export const ENERGY_INPUT_MEDIA_TYPE = 'application/vnd.ontology.energy-input-snapshot+json'

export interface EnergyInputSnapshotPublisherDependencies {
  readonly artifacts: ImmutableArtifactWriter
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const record = value as Record<string, unknown>
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry !== undefined) ordered[key] = canonicalize(entry)
  }
  return ordered
}

/** Deterministic JSON: sorted keys and no `undefined`, so equal inputs serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256DigestOf(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function buildEnergyInputManifest(input: NormalizedEnergyInput): EnergyInputManifest {
  return {
    normalizationVersion: input.normalizationVersion,
    siteRef: input.siteRef,
    evaluationClock: input.evaluationClock,
    horizon: input.horizon,
    timeZone: input.timeZone,
    slotMinutes: input.slotMinutes,
    slotCount: input.slots.length,
    dataMode: input.dataMode,
    versions: input.versions,
    coverage: input.coverage,
    sourceWatermarks: input.sourceWatermarks,
    missingInputs: input.missingInputs,
    series: input.series,
  }
}

/** The digest the manifest bytes must hash to; identical inputs give an identical digest. */
export function energyInputDigest(input: NormalizedEnergyInput): Sha256Digest {
  return sha256DigestOf(new TextEncoder().encode(canonicalJson(buildEnergyInputManifest(input))))
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new EnergyInputError('INVALID_ARGUMENT', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new EnergyInputError('INVALID_ARGUMENT', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

export async function publishEnergyInputSnapshot(
  input: NormalizedEnergyInput,
  deps: EnergyInputSnapshotPublisherDependencies,
  ctx: ToolContext,
): Promise<EnergyInputSnapshot> {
  const manifest = buildEnergyInputManifest(input)
  const bytes = new TextEncoder().encode(canonicalJson(manifest))
  const expected = sha256DigestOf(bytes)

  const stored = await deps.artifacts.putBytes(
    { scopeRef: scopeOf(ctx), content: bytes, mediaType: ENERGY_INPUT_MEDIA_TYPE },
    ctx,
  )
  if (stored.contentDigest !== expected) {
    throw new EnergyInputError(
      'SNAPSHOT_DIGEST_MISMATCH',
      `the archive returned ${stored.contentDigest} but the manifest hashes to ${expected}`,
    )
  }

  return {
    snapshotRef: stored.blobRef,
    digest: stored.contentDigest,
    mediaType: ENERGY_INPUT_MEDIA_TYPE,
    manifest,
  }
}
