import { describe, expect, it, vi } from 'vitest'
import type { CoreModelEvidenceRecorderOptions } from '../../apps/api/src/composition/model-evidence'
import { createCoreModelEvidenceRecorders } from '../../apps/api/src/composition/model-evidence'
import { modelContext } from './model-company-fixtures'

const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OUTPUT_DIGEST = `sha256:${'a'.repeat(64)}`

function harness(scopeOverride?: Partial<CoreModelEvidenceRecorderOptions['scopeRef']>) {
  const ctx = modelContext()
  const stage = vi.fn<CoreModelEvidenceRecorderOptions['blobs']['stage']>(async () => {
    throw new Error('an unauthorized request reached blob staging')
  })
  const publish = vi.fn<CoreModelEvidenceRecorderOptions['blobs']['publish']>(async () => {
    throw new Error('an unauthorized request reached blob publication')
  })
  const record = vi.fn<CoreModelEvidenceRecorderOptions['evidence']['record']>(async () => {
    throw new Error('an unauthorized request reached evidence persistence')
  })
  const recorders = createCoreModelEvidenceRecorders({
    scopeRef: {
      tenantId: ctx.principal.tenantId,
      spaceId: ctx.allowedResources.spaceId,
      ...scopeOverride,
    },
    blobs: { stage, publish },
    evidence: { record },
  })
  return { ctx, stage, publish, record, recorders }
}

describe('Core model evidence identity before archive writes', () => {
  for (const role of ['generation', 'decision'] as const) {
    for (const mismatch of ['run', 'tenant', 'space'] as const) {
      it(`rejects a ${role} ${mismatch} mismatch before any archive or evidence write`, async () => {
        const fixture = harness(mismatch === 'tenant'
          ? { tenantId: OTHER_ID }
          : mismatch === 'space'
            ? { spaceId: OTHER_ID }
            : undefined)
        const runId = mismatch === 'run' ? OTHER_ID : fixture.ctx.runId
        const request = role === 'generation'
          ? fixture.recorders.generation.record({
            runId,
            role: 'extractor',
            outputDigest: OUTPUT_DIGEST,
            stopReason: 'stop',
          }, fixture.ctx)
          : fixture.recorders.decision.record({
            runId,
            modelRef: { modelId: 'controlled-jev', version: '1.0.0' },
            stateRef: { id: OTHER_ID, version: '1.0.0', kind: 'artifact', digest: OUTPUT_DIGEST },
            outcome: 'calibrated',
            results: [],
          }, fixture.ctx)

        await expect(request).rejects.toThrow('canonical run and deployment scope')
        expect(fixture.stage).not.toHaveBeenCalled()
        expect(fixture.publish).not.toHaveBeenCalled()
        expect(fixture.record).not.toHaveBeenCalled()
      })
    }
  }
})
