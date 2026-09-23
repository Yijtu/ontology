import type { ProfileRef, ResolvedProfile, SourceObjectRef, SourceRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { LOCAL_DOCUMENT_SOURCE, LOCAL_POLICY_COLLECTION } from './local-documents'

export const LOCAL_DOCUMENT_PROFILE: ProfileRef = { id: 'local-policy-documents', version: '1.0.0' }
const objectRef: SourceObjectRef = { sourceRef: LOCAL_DOCUMENT_SOURCE, objectPath: LOCAL_POLICY_COLLECTION }
const adapterRef: VersionRef = { id: 'search-bm25', version: '1.0.0', digest: sha256DigestOf('search-bm25@1.0.0') }

export function createLocalDocumentProfile(input: { readonly runtimeRef: VersionRef; readonly policyRef: VersionRef; readonly tenantId: string; readonly spaceId: string }): { readonly profileRef: ProfileRef; readonly sourceRef: SourceRef; readonly collectionRef: string; readonly resolvedProfile: ResolvedProfile } {
  const industryRef = { id: 'local-policy-documents', version: '1.0.0', digest: sha256DigestOf('local-policy-documents@1.0.0') }
  const mappingRef = { id: 'local-policy-documents.index', version: '1.0.0', digest: sha256DigestOf(`${LOCAL_POLICY_COLLECTION}@1.0.0`), role: 'documents' as const, sourceObjectRef: objectRef }
  const snapshotHash = sha256DigestOf(`${LOCAL_DOCUMENT_PROFILE.id}@${LOCAL_DOCUMENT_PROFILE.version}:${mappingRef.digest}:${adapterRef.digest}`)
  return {
    profileRef: LOCAL_DOCUMENT_PROFILE,
    sourceRef: LOCAL_DOCUMENT_SOURCE,
    collectionRef: LOCAL_POLICY_COLLECTION,
    resolvedProfile: {
      industryRef,
      mappingRefs: [mappingRef],
      runtimeRef: input.runtimeRef,
      backendBindings: { documents: { role: 'documents', adapterRef, capabilityNames: ['document_search.keyword'], scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, mappingRef: mappingRef.id } },
      modelBindings: {},
      toolBindings: [{ toolId: 'document_search', enabled: true, maxCallsPerRun: 2 }],
      computeBindings: [],
      policyRef: input.policyRef,
      resolvedVersions: [industryRef, input.runtimeRef, input.policyRef, mappingRef, adapterRef],
      resolvedCapabilities: [], explicitDegradations: [], snapshotHash,
      resolvedAt: new Date().toISOString(),
    },
  }
}
