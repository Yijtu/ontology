import type { ProfileRef, ResolvedProfile, SourceObjectRef, SourceRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { LOCAL_DOCUMENT_SOURCE, LOCAL_POLICY_COLLECTION } from './local-documents'

export const LOCAL_DOCUMENT_PROFILE: ProfileRef = { id: 'local-policy-documents', version: '1.0.0' }
const adapterRef: VersionRef = { id: 'search-bm25', version: '1.0.0', digest: sha256DigestOf('search-bm25@1.0.0') }

export const LOCAL_CANDIDATE_DOCUMENT_PROFILE: ProfileRef = { id: 'local-candidate-records', version: '1.0.0' }

export function createLocalDocumentProfile(input: { readonly runtimeRef: VersionRef; readonly policyRef: VersionRef; readonly tenantId: string; readonly spaceId: string; readonly profileRef?: ProfileRef; readonly sourceRef?: SourceRef; readonly collectionRef?: string; readonly enableSearch?: boolean }): { readonly profileRef: ProfileRef; readonly sourceRef: SourceRef; readonly collectionRef: string; readonly resolvedProfile: ResolvedProfile } {
  const profileRef = input.profileRef ?? LOCAL_DOCUMENT_PROFILE
  const sourceRef = input.sourceRef ?? LOCAL_DOCUMENT_SOURCE
  const collectionRef = input.collectionRef ?? LOCAL_POLICY_COLLECTION
  const objectRef: SourceObjectRef = { sourceRef, objectPath: collectionRef }
  const industryRef = { id: profileRef.id, version: '1.0.0', digest: sha256DigestOf(`${profileRef.id}@1.0.0`) }
  const mappingRef = { id: `${profileRef.id}.index`, version: '1.0.0', digest: sha256DigestOf(`${collectionRef}@1.0.0:${sourceRef.namespace}:${sourceRef.sourceId}`), role: 'documents' as const, sourceObjectRef: objectRef }
  const snapshotHash = sha256DigestOf(`${profileRef.id}@${profileRef.version}:${mappingRef.digest}:${adapterRef.digest}:${input.enableSearch === false ? 'import-only' : 'search-enabled'}`)
  return {
    profileRef,
    sourceRef,
    collectionRef,
    resolvedProfile: {
      industryRef,
      mappingRefs: [mappingRef],
      runtimeRef: input.runtimeRef,
      backendBindings: { documents: { role: 'documents', adapterRef, capabilityNames: ['document_search.keyword'], scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, mappingRef: mappingRef.id } },
      modelBindings: {},
      toolBindings: input.enableSearch === false ? [] : [{ toolId: 'document_search', enabled: true, maxCallsPerRun: 2 }],
      computeBindings: [],
      policyRef: input.policyRef,
      resolvedVersions: [industryRef, input.runtimeRef, input.policyRef, mappingRef, adapterRef],
      resolvedCapabilities: [], explicitDegradations: [], snapshotHash,
      resolvedAt: new Date().toISOString(),
    },
  }
}
