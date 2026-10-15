import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  TOOL_IDS,
  type AnswerDraftV3Body,
  type IndustryWorkspace,
  type MappingRef,
  type ProjectRevision,
  type ProjectRevisionBody,
  type ProjectRevisionRef,
  type PublishedAnswerBody,
  type PublishedAnswerV3Envelope,
  type PublishedTaskBinding,
  type PublishedTaskBindingBody,
  type ResolvedProfileRef,
  type ResourceRef,
  type RunExecutionBinding,
  type TaskCapabilityStatus,
  type UiCapabilityMetadata,
  type VersionRef,
} from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, readSchemaDocument, validator, wireRoundTrip } from './helpers'

/**
 * V03-002 (#173): the additive public contracts fixed before the v0.3 assistant work.
 *
 * Every new shape is validated at runtime (not just by TypeScript), unknown/extra fields are
 * rejected, required fields and version markers are enforced, and the canonical hash bodies
 * (`ProjectRevisionBody`, `PublishedTaskBindingBody`, `AnswerDraftV3Body`) are proven separate
 * from their read envelopes so no body hashes its own ref/digest or a post-draft receipt.
 */

const PROJECT_ID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const WORKSPACE_ID = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'
const CANDIDATE_ID = '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const RUN_ID = '9c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f'
const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

const versionRef: VersionRef = { id: 'pack.transport', version: '1.0.0', digest: DIGEST }
const resourceRef: ResourceRef = { id: PROJECT_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const resolvedProfileRef: ResolvedProfileRef = {
  id: 'profile.transport',
  version: '1.0.0',
  snapshotHash: DIGEST,
}
const mappingRef: MappingRef = {
  id: 'mapping.transport',
  version: '1.0.0',
  digest: DIGEST,
  role: 'catalog',
  sourceObjectRef: {
    sourceRef: { namespace: 'transport', sourceId: 'road-records' },
    objectPath: 'records',
  },
}

const projectRevisionRef: ProjectRevisionRef = { projectId: PROJECT_ID, revision: '7', digest: DIGEST }

/** Copy an object without the named fields, to prove a required field is genuinely enforced. */
function omit(value: object, ...keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function projectRevisionBody(): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '7',
    industryPackRef: versionRef,
    definitionRef: versionRef,
    mappingRefs: [mappingRef],
    profileRef: resolvedProfileRef,
    documentSetRef: resourceRef,
    semanticPublicationRefs: [versionRef],
    sourceVisibilityEpoch: '3',
    changeReason: 'initial approval',
  }
}

function projectRevision(): ProjectRevision {
  return {
    ref: projectRevisionRef,
    industryPackRef: versionRef,
    definitionRef: versionRef,
    mappingRefs: [mappingRef],
    profileRef: resolvedProfileRef,
    documentSetRef: resourceRef,
    semanticPublicationRefs: [versionRef],
    sourceVisibilityEpoch: '3',
    changeReason: 'initial approval',
  }
}

function approvedInputSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 'project-input-snapshot@1',
    projectId: PROJECT_ID,
    inputRevision: '4',
    definitionRef: versionRef,
    mappingRefs: [mappingRef],
    recordPages: [{ ref: resourceRef, rowCount: 250, firstRecordId: PROJECT_ID, lastRecordId: WORKSPACE_ID }],
    counts: { total: 1001, confirmed: 900, approved: 900, excluded: 1, pending: 100, failed: 0 },
    excluded: [{ recordId: CANDIDATE_ID, reason: 'duplicate', actor: 'reviewer-1' }],
    coverage: 'partial',
    confirmationManifestRef: resourceRef,
  }
}

function publishedTaskBindingBody(): PublishedTaskBindingBody {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingIdentity: { id: 'task.transport.door-count', version: '1.0.0' },
    actionDefinitionRef: versionRef,
    kind: 'structured_query',
    parameterSchema: { type: 'object' },
    parameterSchemaDigest: DIGEST,
    requiredCapabilities: ['sql.readonly'],
    requiredReadiness: ['dataset'],
    resultSchemaRef: versionRef,
  }
}

function publishedTaskBinding(): Record<string, unknown> {
  return {
    ...omit(publishedTaskBindingBody(), 'taskBindingIdentity'),
    taskBindingRef: { id: 'task.transport.door-count', version: '1.0.0', digest: DIGEST },
    validationPolicies: [
      {
        policyRef: versionRef,
        stage: 'result',
        required: true,
        registryDigest: DIGEST_B,
        reportSchemaRef: versionRef,
      },
    ],
  }
}

function runExecutionBinding(): RunExecutionBinding {
  return {
    schemaVersion: 'run-execution-binding@1',
    runId: RUN_ID,
    request: {
      mode: 'task',
      projectRevisionRef,
      inputSnapshotRef: resourceRef,
      inputSnapshotDigest: DIGEST,
      taskBindingRef: { id: 'task.transport.door-count', version: '1.0.0', digest: DIGEST },
      parameters: { windowDays: 30 },
    },
    resolvedProfileRef,
    runtimeRef: versionRef,
    allowedTaskBindingRefs: [versionRef],
    inputManifestDigestAtCreation: DIGEST,
    effectiveLimitsRef: versionRef,
    effectiveTime: { validAt: '2026-09-29T00:00:00Z', asOfRecordedSeq: '12' },
  }
}

function readinessProjection(): Record<string, unknown> {
  return {
    projectRevisionRef,
    kind: 'dataset',
    targetRef: resourceRef,
    state: 'building',
    completeness: 'partial',
    expectedCount: 1001,
    processedCount: 250,
    failedCount: 0,
    targetDigest: DIGEST,
    receiptRef: resourceRef,
    fenceRevision: '3',
    jobId: RUN_ID,
    error: { code: 'PROJECT_DATA_NOT_READY', retryable: true, message: 'still materializing' },
  }
}

function taskCapabilityStatus(): TaskCapabilityStatus {
  return {
    schemaVersion: 'task-capability-status@1',
    taskBindingRef: { id: 'task.transport.door-count', version: '1.0.0', digest: DIGEST },
    state: 'not_ready',
    requiredCapabilities: ['sql.readonly'],
    requiredReadiness: ['dataset'],
    blockers: [
      {
        code: 'PROJECT_DATA_NOT_READY',
        message: 'dataset projection is not ready',
        retryable: true,
        readinessKind: 'dataset',
      },
    ],
  }
}

function uiCapabilityMetadata(): UiCapabilityMetadata {
  return {
    moduleRef: { id: 'web.scenario.transport', version: '1.0.0', digest: DIGEST },
    taskBindingRefs: [{ id: 'task.transport.door-count', version: '1.0.0', digest: DIGEST }],
    requiredCapabilities: ['sql.readonly'],
  }
}

describe('v0.3 public contracts — canonical schemas are runtime-validated', () => {
  let ajv: Ajv2020
  beforeAll(() => {
    ajv = createAjv()
  })

  const validate = (file: string, def: string): ValidateFunction => validator(ajv, file, def)

  describe('industry workspace (asset-workspace.schema.json)', () => {
    const workspace = (): IndustryWorkspace => ({
      workspaceId: WORKSPACE_ID,
      namespace: 'transport-operations',
      displayName: '交通运营本体',
      boundary: {
        goals: ['统计路门数量'],
        included: ['公路资产'],
        excluded: ['铁路'],
        applicability: { region: 'cn-east', validFrom: '2026-01-01T00:00:00Z' },
      },
      headRevision: '12',
      latestPublishedPackRef: versionRef,
      state: 'draft',
    })

    it('accepts a well-formed workspace and rejects drift', () => {
      const v = validate('asset-workspace.schema.json', 'IndustryWorkspace')
      expectValid(v, workspace(), 'workspace')
      // additive extension is not silently accepted
      expectInvalid(v, { ...workspace(), extra: true }, 'workspace with unknown field')
      expectInvalid(v, omit(workspace(), 'boundary'), 'workspace missing boundary')
      expectInvalid(v, { ...workspace(), state: 'live' }, 'workspace with unknown state')
      expectInvalid(v, { ...workspace(), headRevision: 'r12' }, 'workspace with non-decimal revision')
    })

    it('requires applicability inside the boundary', () => {
      const v = validate('asset-workspace.schema.json', 'IndustryWorkspaceBoundary')
      expectInvalid(v, omit(workspace().boundary, 'applicability'), 'boundary without applicability')
    })

    it('validates append-only draft versions', () => {
      const v = validate('asset-workspace.schema.json', 'AssetDraftVersion')
      const draft = {
        workspaceId: WORKSPACE_ID,
        revision: '12',
        digest: DIGEST,
        documentSetRef: resourceRef,
        candidateRefs: [{ logicalId: 'object.door', candidateId: CANDIDATE_ID, digest: DIGEST }],
      }
      expectValid(v, draft, 'draft version')
      expectInvalid(v, { ...draft, candidateRefs: [{ logicalId: 'object.door' }] }, 'candidate ref missing id')
    })
  })

  describe('project revision and approved input (projects.schema.json)', () => {
    it('keeps the canonical hash body free of its own ref/digest', () => {
      const v = validate('projects.schema.json', 'ProjectRevisionBody')
      expectValid(v, projectRevisionBody(), 'project revision body')
      // The body must not carry the outer ref or its digest: those are added by the envelope.
      expectInvalid(v, { ...projectRevisionBody(), ref: projectRevisionRef }, 'body with ref')
      expectInvalid(v, { ...projectRevisionBody(), digest: DIGEST }, 'body with digest')
      expectInvalid(v, { ...projectRevisionBody(), schemaVersion: 'project-revision@2' }, 'wrong version')
      expectInvalid(v, omit(projectRevisionBody(), 'changeReason'), 'body missing changeReason')
    })

    it('accepts the read envelope and its exact ref', () => {
      const v = validate('projects.schema.json', 'ProjectRevision')
      expectValid(v, projectRevision(), 'project revision envelope')
      expectInvalid(v, { ...projectRevision(), ref: { projectId: PROJECT_ID, revision: '7' } }, 'ref missing digest')

      const refValidator = validate('projects.schema.json', 'ProjectRevisionRef')
      expectValid(refValidator, projectRevisionRef, 'project revision ref')
      expectInvalid(refValidator, { ...projectRevisionRef, digest: 'sha256:short' }, 'bad digest')
    })

    it('validates the immutable approved-input artifact and proves the envelope adds refs', () => {
      const body = validate('projects.schema.json', 'ApprovedInputSnapshot')
      const snapshot = approvedInputSnapshot()
      expectValid(body, snapshot, 'approved input body')
      expectInvalid(body, { ...snapshot, digest: DIGEST }, 'body with own digest')
      expectInvalid(body, { ...snapshot, projectRevisionRef }, 'body with final revision ref')
      expectInvalid(body, { ...snapshot, schemaVersion: 'project-input-snapshot@2' }, 'wrong version')
      expectInvalid(body, omit(snapshot, 'counts'), 'body missing counts')

      const envelope = validate('projects.schema.json', 'ApprovedInputSnapshotEnvelope')
      expectValid(
        envelope,
        { projectRevisionRef, inputSnapshotRef: resourceRef, snapshot },
        'approved input envelope',
      )
    })
  })

  describe('readiness and capability status', () => {
    it('accepts a readiness projection and rejects unknown kinds/states', () => {
      const v = validate('projects.schema.json', 'ReadinessProjection')
      expectValid(v, readinessProjection(), 'readiness projection')
      expectInvalid(v, { ...readinessProjection(), kind: 'cache' }, 'unknown readiness kind')
      expectInvalid(v, { ...readinessProjection(), state: 'done' }, 'unknown readiness state')
      expectInvalid(v, { ...readinessProjection(), completeness: 'mostly' }, 'unknown completeness')
    })

    it('accepts either a ResourceRef or a VersionRef as the projected target', () => {
      const v = validate('projects.schema.json', 'ReadinessProjection')
      expectValid(v, { ...readinessProjection(), targetRef: resourceRef }, 'resource target')
      expectValid(v, { ...readinessProjection(), targetRef: versionRef }, 'version target')
      expectInvalid(v, { ...readinessProjection(), targetRef: { id: 'x', version: '1.0.0' } }, 'neither')
    })

    it('validates task capability status and its blockers', () => {
      const v = validate('tasks.schema.json', 'TaskCapabilityStatus')
      expectValid(v, taskCapabilityStatus(), 'capability status')
      expectInvalid(v, { ...taskCapabilityStatus(), state: 'maybe' }, 'unknown capability state')
      expectInvalid(
        v,
        { ...taskCapabilityStatus(), blockers: [{ code: 'X', retryable: true }] },
        'blocker missing message',
      )
      expectInvalid(v, { ...taskCapabilityStatus(), schemaVersion: 'task-capability-status@2' }, 'wrong version')
    })
  })

  describe('published task binding (tasks.schema.json)', () => {
    it('keeps the hash body free of the full taskBindingRef', () => {
      const v = validate('tasks.schema.json', 'PublishedTaskBindingBody')
      expectValid(v, publishedTaskBindingBody(), 'task binding body')
      expectInvalid(v, { ...publishedTaskBindingBody(), taskBindingRef: versionRef }, 'body with taskBindingRef')
      expectInvalid(v, { ...publishedTaskBindingBody(), digest: DIGEST }, 'body with digest')
      expectInvalid(v, { ...publishedTaskBindingBody(), kind: 'script' }, 'unknown task kind')
      expectInvalid(v, { ...publishedTaskBindingBody(), schemaVersion: 'published-task-binding@2' }, 'wrong version')
    })

    it('accepts the flat read envelope and its validation policy bindings', () => {
      const v = validate('tasks.schema.json', 'PublishedTaskBinding')
      expectValid(v, publishedTaskBinding(), 'task binding envelope')
      expectValid(v, omit(publishedTaskBinding(), 'validationPolicies'), 'task binding without optional policies')
      expectInvalid(
        v,
        { ...publishedTaskBinding(), validationPolicies: [{ policyRef: versionRef, stage: 'during' }] },
        'invalid policy stage',
      )
    })

    it('validates the run execution request discriminated union', () => {
      const v = validate('tasks.schema.json', 'RunExecutionRequest')
      expectValid(
        v,
        {
          mode: 'question',
          projectRevisionRef,
          inputSnapshotRef: resourceRef,
          inputSnapshotDigest: DIGEST,
        },
        'question mode',
      )
      expectValid(
        v,
        {
          mode: 'task',
          projectRevisionRef,
          inputSnapshotRef: resourceRef,
          inputSnapshotDigest: DIGEST,
          taskBindingRef: versionRef,
          parameters: {},
        },
        'task mode',
      )
      expectInvalid(
        v,
        {
          mode: 'question',
          projectRevisionRef,
          inputSnapshotRef: resourceRef,
          inputSnapshotDigest: DIGEST,
          taskBindingRef: versionRef,
        },
        'question mode with a task binding',
      )
      expectInvalid(
        v,
        { mode: 'task', projectRevisionRef, inputSnapshotRef: resourceRef, inputSnapshotDigest: DIGEST },
        'task mode without a binding',
      )
    })

    it('validates the immutable execution binding', () => {
      const v = validate('tasks.schema.json', 'RunExecutionBinding')
      expectValid(v, runExecutionBinding(), 'execution binding')
      expectInvalid(v, { ...runExecutionBinding(), schemaVersion: 'run-execution-binding@2' }, 'wrong version')
      expectInvalid(v, omit(runExecutionBinding(), 'effectiveTime'), 'binding missing effectiveTime')
    })
  })

  describe('public UI mount metadata (mount.schema.json)', () => {
    it('accepts data-only mount metadata and rejects a component/code payload', () => {
      const v = validate('mount.schema.json', 'UiCapabilityMetadata')
      expectValid(v, uiCapabilityMetadata(), 'ui capability metadata')
      // The mount contract is data only: React/components/bundles never appear here.
      expectInvalid(v, { ...uiCapabilityMetadata(), component: 'TransportPanel' }, 'metadata with a component')
      expectInvalid(v, { ...uiCapabilityMetadata(), moduleUrl: 'https://example.com/x.js' }, 'metadata with a url')
      expectInvalid(v, omit(uiCapabilityMetadata(), 'requiredCapabilities'), 'metadata missing requiredCapabilities')
    })
  })

  describe('body <-> envelope property sync (prevents silent drift)', () => {
    const propsOf = (file: string, def: string): string[] => {
      const defs = readSchemaDocument(file).$defs ?? {}
      return Object.keys((defs[def] as { properties: Record<string, unknown> }).properties)
    }

    it('PublishedTaskBinding envelope = body - {taskBindingIdentity} + {taskBindingRef}', () => {
      const body = new Set(propsOf('tasks.schema.json', 'PublishedTaskBindingBody'))
      const envelope = new Set(propsOf('tasks.schema.json', 'PublishedTaskBinding'))
      body.delete('taskBindingIdentity')
      const expected = new Set([...body, 'taskBindingRef'])
      expect([...envelope].sort()).toEqual([...expected].sort())
    })

    it('ProjectRevision envelope = body - {schemaVersion, projectId, revision} + {ref}', () => {
      const body = new Set(propsOf('projects.schema.json', 'ProjectRevisionBody'))
      const envelope = new Set(propsOf('projects.schema.json', 'ProjectRevision'))
      body.delete('schemaVersion')
      body.delete('projectId')
      body.delete('revision')
      const expected = new Set([...body, 'ref'])
      expect([...envelope].sort()).toEqual([...expected].sort())
    })
  })
})

describe('v0.3 task/project body vs read envelope (type level)', () => {
  it('never counts a body ref/digest back into the content it hashes', () => {
    expectTypeOf<PublishedTaskBinding>().toHaveProperty('taskBindingRef')
    expectTypeOf<PublishedTaskBindingBody>().toHaveProperty('taskBindingIdentity')
    expectTypeOf<PublishedTaskBindingBody>().not.toHaveProperty('taskBindingRef')

    expectTypeOf<ProjectRevision>().toHaveProperty('ref')
    expectTypeOf<ProjectRevisionBody>().toHaveProperty('schemaVersion')
    expectTypeOf<ProjectRevisionBody>().not.toHaveProperty('ref')
  })
})

describe('v0.3 answer-draft@3 body is separate from its read envelope', () => {
  it('keeps self-digest and post-draft receipts out of the body type', () => {
    expectTypeOf<AnswerDraftV3Body['schemaVersion']>().toEqualTypeOf<'answer-draft@3'>()
    expectTypeOf<AnswerDraftV3Body>().not.toHaveProperty('contentHash')
    expectTypeOf<AnswerDraftV3Body>().not.toHaveProperty('verificationId')
    expectTypeOf<AnswerDraftV3Body>().not.toHaveProperty('verificationReceiptRef')
    expectTypeOf<AnswerDraftV3Body>().not.toHaveProperty('tableVerificationReceiptRef')

    expectTypeOf<PublishedAnswerV3Envelope>().toHaveProperty('contentHash')
    expectTypeOf<PublishedAnswerV3Envelope>().toHaveProperty('verificationId')
    expectTypeOf<PublishedAnswerV3Envelope['body']>().toEqualTypeOf<AnswerDraftV3Body>()
  })

  it('round-trips a @3 body with no hashed receipts', () => {
    const body: AnswerDraftV3Body = {
      schemaVersion: 'answer-draft@3',
      resultManifestRef: resourceRef,
      resultManifestDigest: DIGEST,
      finalizationReceiptRef: resourceRef,
      finalizationReceiptDigest: DIGEST_B,
      executionBindingRef: resourceRef,
      blocks: [{ kind: 'text', text: '已核验结果' }],
      claims: [],
      assertions: [],
      limitations: [],
    }
    const wire = wireRoundTrip(body)
    expect(wire).toEqual(body)
    expect(Object.keys(wire)).not.toContain('contentHash')
    expect(Object.keys(wire)).not.toContain('verificationId')
  })

  it('leaves answer-draft@1/@2 readers unchanged', () => {
    expectTypeOf<PublishedAnswerBody['schemaVersion']>().toEqualTypeOf<'answer-draft@1' | 'answer-draft@2'>()
  })
})

describe('v0.3 contracts stay additive over the existing public surface', () => {
  it('keeps the fixed four model-selectable data tools and no others', () => {
    expect([...TOOL_IDS].sort()).toEqual(['data_query', 'document_search', 'ontology_lookup', 'web_search'])
  })
})
