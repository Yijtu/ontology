import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertTypedResultManifestShape } from '@ontology/contracts'
import {
  buildTypedResultManifest,
  summarizeTypedResultEvidence,
  typedResultManifestContentDigest,
} from '@ontology/application'
import type { ResourceRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { buildEvidence, InMemoryVerificationEvidence, ownerContext, SCOPE_A } from './verification-fixtures'

/**
 * V03-037 / #208 unit checks for the typed-result context producer's pure summary/build steps.
 * The end-to-end wiring (HTTP + Template + publication) is proven by
 * `tests/integration/template-task-host-postgres.spec.ts`; here we pin the deterministic
 * manifest shape and coverage semantics that the @3 body depends on.
 */

const DIGEST = sha256DigestOf('typed-result-context-digest')
const VERSION_REF: VersionRef = { id: 'task.demo', version: '1.0.0', digest: DIGEST }
const EXECUTION_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'plan' }
const INPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const OUT_SCHEMA_REF: VersionRef = { id: 'typed-result-manifest', version: '1.0.0', digest: DIGEST }

async function recordedEvidence(kind: 'observation' | 'computation'): Promise<{ ref: ResourceRef; record: Awaited<ReturnType<InMemoryVerificationEvidence['record']>> }> {
  const evidence = new InMemoryVerificationEvidence()
  const payloadRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
  const record = await evidence.record(SCOPE_A, buildEvidence({ evidenceId: randomUUID(), payloadRef, resultDigest: payloadRef.digest, kind }))
  return { ref: record.evidenceRef, record }
}

describe('typed-result context summary', () => {
  it('counts a complete fact page as known and complete', async () => {
    const { ref, record } = await recordedEvidence('observation')
    const summary = summarizeTypedResultEvidence(SCOPE_A, ref, record, { items: [{}, {}, {}] }, ownerContext())
    expect(summary.returned).toBe(3)
    expect(summary.truncated).toBe(false)
    expect(summary.domainStatus).toBe('known')
    expect(summary.kind).toBe('observation')
  })

  it('never reports a truncated or gapped result as complete', async () => {
    const { ref, record } = await recordedEvidence('observation')
    const truncated = summarizeTypedResultEvidence(SCOPE_A, ref, record, { items: [{}], coverage: { returned: 1, truncated: true } }, ownerContext())
    expect(truncated.truncated).toBe(true)
    expect(truncated.domainStatus).toBe('unknown')

    const gapped = summarizeTypedResultEvidence(SCOPE_A, ref, record, { items: [{}], gaps: [{ code: 'MISSING_ROW' }] }, ownerContext())
    expect(gapped.truncated).toBe(true)
    expect(gapped.domainStatus).toBe('unknown')
  })
})

describe('typed-result manifest builder', () => {
  it('builds a runtime-valid manifest whose digest recomputes from its body', async () => {
    const first = await recordedEvidence('observation')
    const second = await recordedEvidence('computation')
    const evidence = [
      summarizeTypedResultEvidence(SCOPE_A, first.ref, first.record, { items: [{}, {}] }, ownerContext()),
      summarizeTypedResultEvidence(SCOPE_A, second.ref, second.record, { items: [{}] }, ownerContext()),
    ]
    const manifest = buildTypedResultManifest({
      executionBindingRef: EXECUTION_REF,
      taskBindingRef: VERSION_REF,
      resultKind: 'compute',
      outputSchemaRef: OUT_SCHEMA_REF,
      inputSnapshotRef: INPUT_REF,
      outputDigest: sha256DigestOf('output'),
      evidence,
    })
    expect(() => assertTypedResultManifestShape(manifest)).not.toThrow()
    expect(manifest.coverage.returned).toBe(3)
    expect(manifest.coverage.truncated).toBe(false)
    expect(manifest.tables).toEqual([])
    expect(typedResultManifestContentDigest(manifest)).toMatch(/^sha256:[0-9a-f]{64}$/u)

    // The content digest is stable and does not depend on the evidence ordering.
    const reordered = buildTypedResultManifest({
      executionBindingRef: EXECUTION_REF,
      taskBindingRef: VERSION_REF,
      resultKind: 'compute',
      outputSchemaRef: OUT_SCHEMA_REF,
      inputSnapshotRef: INPUT_REF,
      outputDigest: sha256DigestOf('output'),
      evidence: [...evidence].reverse(),
    })
    expect(typedResultManifestContentDigest(reordered)).toBe(typedResultManifestContentDigest(manifest))
  })

  it('marks a manifest incomplete when any evidence is truncated', async () => {
    const { ref, record } = await recordedEvidence('observation')
    const evidence = [summarizeTypedResultEvidence(SCOPE_A, ref, record, { items: [{}], coverage: { returned: 1, truncated: true } }, ownerContext())]
    const manifest = buildTypedResultManifest({
      executionBindingRef: EXECUTION_REF,
      taskBindingRef: VERSION_REF,
      resultKind: 'published_facts',
      outputSchemaRef: OUT_SCHEMA_REF,
      inputSnapshotRef: INPUT_REF,
      outputDigest: sha256DigestOf('output'),
      evidence,
    })
    expect(manifest.coverage.truncated).toBe(true)
    expect(manifest.domainStatus).toBe('unknown')
  })
})
