import type { EvidenceReadSurface, HistoryReadSurface } from '@ontology/app-api'
import { ProvenanceReadError } from '@ontology/provenance'
import { HistoryReadError } from '@ontology/semantic-engine'
import type {
  DependencyGraphView,
  EvidenceExportView,
  HistoricalAssertionView,
  ObjectHistoryView,
  ProvenanceEvidenceView,
  ResourceRef,
  VersionRef,
} from '@ontology/contracts'
import { SCOPE, SENTINEL_SECRET } from './workbench-fixtures'

/**
 * A controlled C6 evidence/history read surface for the UI and browser E2E suites.
 *
 * It is a deterministic test double of the provenance/history routes: it returns the real
 * wire shapes (rule, premise groups, source snapshots, bounded graph with an explicit
 * truncation flag, immutable history versions) and it deliberately injects fields that a
 * misbehaving backend might send — a fabricated chain-of-thought and a resolved secret — so
 * the UI tests can prove the interface renders only the real server fields and never those.
 *
 * The real read semantics (RPC, truncation, re-readability, cross-tenant 404) are proven
 * separately against a real PostgreSQL container in `tests/integration`.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`

export const EVIDENCE_ID = '00000000-0000-4000-8000-0000000000e1'
export const FORBIDDEN_EVIDENCE_ID = '00000000-0000-4000-8000-0000000000f0'
export const UNKNOWN_EVIDENCE_ID = '00000000-0000-4000-8000-0000000000ff'
export const PREMISE_A = '00000000-0000-4000-8000-0000000000a1'
export const PREMISE_B = '00000000-0000-4000-8000-0000000000b1'
export const PREMISE_C = '00000000-0000-4000-8000-0000000000c1'
export const HISTORY_OBJECT_ID = 'device.battery'
export const FORBIDDEN_OBJECT_ID = 'device.other-tenant'
export const GRAPH_CURSOR = 'graph-page-2'

/** A fabricated reasoning string a model might emit; the UI must never render it. */
export const COT_SENTINEL = 'FABRICATED-CHAIN-OF-THOUGHT-2f8c1'
/** A resolved secret value; it must never appear in HTML, responses-as-rendered or events. */
export const SECRET_SENTINEL = SENTINEL_SECRET
/** The original text of an object the caller is not authorized to read. */
export const OTHER_TENANT_TEXT = 'OTHER-TENANT-ORIGINAL-TEXT-9d4e'
/** A visible locator of the authorized evidence, so a test can prove it is cleared on 403. */
export const AUTHORIZED_SOURCE_LOCATOR = 'postgres://public.meter_readings'

function componentRef(): VersionRef {
  return { id: 'component.provenance', version: '1.0.0', digest: DIGEST }
}

function ruleRef(): VersionRef {
  return { id: 'rule.battery-ready', version: '1', digest: DIGEST }
}

function payloadRef(): ResourceRef {
  return { id: '00000000-0000-4000-8000-0000000000p1', version: '1.0.0', digest: DIGEST, kind: 'evidence' }
}

function knownEvidence(): ProvenanceEvidenceView {
  return {
    evidenceId: EVIDENCE_ID,
    outcome: 'verifiable',
    kind: 'rule_derivation',
    dataMode: 'observed',
    scopeRef: { tenantId: SCOPE.tenantId, spaceId: SCOPE.spaceId },
    producedBy: {
      componentRef: componentRef(),
      runId: '33333333-3333-4333-8333-333333333333',
      ruleRef: ruleRef(),
    },
    observedAt: '2026-09-21T06:00:00Z',
    recordedAt: '2026-09-21T06:01:00Z',
    revision: '1',
    resultDigest: DIGEST,
    integrityVerified: true,
    ruleRefs: [ruleRef()],
    premiseGroups: [
      { groupId: 'g1', alternativeEvidenceIds: [PREMISE_A, PREMISE_B] },
      { groupId: 'g2', alternativeEvidenceIds: [PREMISE_C] },
    ],
    sources: [
      {
        sourceRef: { namespace: 'postgres', sourceId: 'public.meter_readings' },
        schemaVersion: '1',
        readAt: '2026-09-21T05:00:00Z',
        consistency: 'immutable',
        resultDigest: DIGEST,
        reReadability: 're_readable',
      },
      {
        sourceRef: { namespace: 'document', sourceId: 'battery-manual.pdf' },
        schemaVersion: '1',
        readAt: '2026-09-21T05:30:00Z',
        consistency: 'repeatable_read',
        resultDigest: DIGEST,
        archivedResultRef: payloadRef(),
        reReadability: 'archived_snapshot_only',
        reason: 'the original source is not guaranteed re-readable; the archived snapshot was verified',
      },
    ],
    archivedResult: { ref: payloadRef(), verified: true },
    originalSourceReReadable: true,
    dependencies: [
      {
        fromEvidenceId: EVIDENCE_ID,
        toEvidenceId: PREMISE_A,
        relation: 'supports',
        origin: 'support',
        premiseGroup: 'g1',
      },
      {
        fromEvidenceId: EVIDENCE_ID,
        toEvidenceId: PREMISE_C,
        relation: 'supports',
        origin: 'support',
        premiseGroup: 'g2',
      },
    ],
  }
}

/**
 * The dependency graph page. The first page is explicitly truncated with a cursor; the second
 * (cursor) page completes the traversal. A truncated traversal must never read as completeness.
 */
function dependencyPage(
  direction: DependencyGraphView['direction'],
  cursor: string | undefined,
  depth: number,
): DependencyGraphView {
  const root = {
    evidenceId: EVIDENCE_ID,
    depth: 0,
    outcome: 'verifiable' as const,
    kind: 'rule_derivation' as const,
  }
  const nodes = [
    root,
    { evidenceId: PREMISE_A, depth: 1, outcome: 'verifiable' as const, kind: 'observation' as const },
    { evidenceId: PREMISE_B, depth: 1, outcome: 'verifiable' as const, kind: 'observation' as const },
    { evidenceId: PREMISE_C, depth: 1, outcome: 'unverifiable' as const },
  ]
  const edges = [
    { fromEvidenceId: EVIDENCE_ID, toEvidenceId: PREMISE_A, relation: 'supports' as const, origin: 'support' as const },
    { fromEvidenceId: EVIDENCE_ID, toEvidenceId: PREMISE_B, relation: 'supports' as const, origin: 'support' as const },
    { fromEvidenceId: EVIDENCE_ID, toEvidenceId: PREMISE_C, relation: 'supports' as const, origin: 'support' as const },
  ]
  const complete = cursor === GRAPH_CURSOR
  return {
    rootEvidenceId: EVIDENCE_ID,
    direction,
    depth,
    nodes: complete ? nodes.slice(1) : nodes.slice(0, 1),
    edges: complete ? edges.slice(1) : edges.slice(0, 1),
    coverage: {
      returned: complete ? nodes.length - 1 : 1,
      knownTotal: nodes.length,
      ...(complete ? {} : { cursor: GRAPH_CURSOR }),
      truncated: !complete,
    },
  }
}

function baseAssertion(): HistoricalAssertionView {
  return {
    statementId: '00000000-0000-4000-8000-0000000000s1',
    propositionKey: 'device.battery_present',
    predicate: 'device.battery_present',
    kind: 'entity',
    objectId: HISTORY_OBJECT_ID,
    version: '1',
    status: 'active',
    value: { value: true },
    validFrom: '2026-09-21T00:00:00Z',
    validTo: '2026-09-22T00:00:00Z',
    recordedAt: '2026-09-21T00:00:00Z',
    sourceRefs: [{ id: EVIDENCE_ID, version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
  }
}

function retractedAssertion(): HistoricalAssertionView {
  return {
    ...baseAssertion(),
    version: '2',
    status: 'retracted',
    recordedAt: '2026-09-21T12:00:00Z',
    revisionKind: 'retraction',
    revisionReason: 'the only supporting source was withdrawn',
    supersedesVersion: '1',
  }
}

export interface ProvenanceHost {
  readonly evidence: EvidenceReadSurface
  readonly history: HistoryReadSurface
  /** Simulate a version change: the next history read includes the retraction version. */
  advanceHistory(): void
  /** Revert to the single-version history. */
  resetHistory(): void
}

export function createProvenanceHost(): ProvenanceHost {
  let advanced = false

  const evidence: EvidenceReadSurface = {
    getEvidence(evidenceId: string): Promise<ProvenanceEvidenceView> {
      if (evidenceId === FORBIDDEN_EVIDENCE_ID) {
        return Promise.reject(
          new ProvenanceReadError('SCOPE_MISMATCH', 'the caller is not authorized for this evidence scope'),
        )
      }
      if (evidenceId !== EVIDENCE_ID) {
        return Promise.reject(
          new ProvenanceReadError('EVIDENCE_NOT_FOUND', `no authorized evidence ${evidenceId} in the requested scope`),
        )
      }
      const view = knownEvidence()
      // Extra, non-contract fields a misbehaving backend might attach. The UI must ignore them.
      return Promise.resolve({
        ...view,
        chainOfThought: COT_SENTINEL,
        modelReasoning: COT_SENTINEL,
        resolvedSecret: SECRET_SENTINEL,
        otherTenantText: OTHER_TENANT_TEXT,
      })
    },
    getDependencies(evidenceId: string, traversal): Promise<DependencyGraphView> {
      if (evidenceId !== EVIDENCE_ID) {
        return Promise.reject(
          new ProvenanceReadError('EVIDENCE_NOT_FOUND', `no authorized evidence ${evidenceId} in the requested scope`),
        )
      }
      return Promise.resolve(dependencyPage(traversal.direction, traversal.cursor, traversal.depth))
    },
    exportEvidence(): Promise<EvidenceExportView> {
      return Promise.resolve({ view: knownEvidence(), artifacts: [] })
    },
  }

  const history: HistoryReadSurface = {
    getObjectHistory(objectId: string, query): Promise<ObjectHistoryView> {
      if (objectId === FORBIDDEN_OBJECT_ID) {
        return Promise.reject(
          new HistoryReadError('SCOPE_MISMATCH', 'the caller is not authorized for this object scope'),
        )
      }
      const assertions =
        objectId === HISTORY_OBJECT_ID
          ? advanced
            ? [baseAssertion(), retractedAssertion()]
            : [baseAssertion()]
          : []
      const filtered = assertions.filter(
        (assertion) => query.recordedAt === undefined || assertion.recordedAt <= query.recordedAt,
      )
      return Promise.resolve({
        objectId,
        ...(query.recordedAt === undefined ? {} : { recordedAt: query.recordedAt }),
        ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
        assertions: filtered,
        coverage: { returned: filtered.length, knownTotal: filtered.length, truncated: false },
      })
    },
  }

  return {
    evidence,
    history,
    advanceHistory: () => {
      advanced = true
    },
    resetHistory: () => {
      advanced = false
    },
  }
}

