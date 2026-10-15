import type { MappingRef, ResolvedProfileRef, ResourceRef, SourceObjectRef } from '@ontology/contracts'
import type { CoreDeploymentScenario, WorkbenchClient } from './api/client'
import type { ProjectBinding } from './components/ProjectWorkspacePanel'
import { webWorkspaceIdentity } from './workspace-identity'

/**
 * Derive the project-create binding the projects workbench needs from the active Core deployment
 * scenario (V03 unified entry). The scenario metadata is transport-shaped: `profileRef` carries no
 * resolved snapshot hash and `mappingRefs` is published as a bare version list even though a real
 * Core host serialises full `MappingRef` rows. Nothing is fabricated — the resolved snapshot hash
 * is read from the real run-scope endpoint, and the binding is withheld unless every mapping row
 * actually validates as a `MappingRef`. When the scenario cannot back a project binding the caller
 * shows the explicit guidance state instead of a project panel seeded with invented data.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSourceObjectRef(value: unknown): value is SourceObjectRef {
  if (!isRecord(value)) return false
  const sourceRef = value['sourceRef']
  return (
    isRecord(sourceRef) &&
    isNonEmptyString(sourceRef['namespace']) &&
    isNonEmptyString(sourceRef['sourceId']) &&
    isNonEmptyString(value['objectPath'])
  )
}

/** Runtime narrowing of the scenario's deployed mapping list to a full `MappingRef`. */
export function isMappingRef(value: unknown): value is MappingRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['version']) &&
    isNonEmptyString(value['digest']) &&
    isNonEmptyString(value['role']) &&
    isSourceObjectRef(value['sourceObjectRef'])
  )
}

export async function deriveProjectBinding(
  client: WorkbenchClient,
  scenario: CoreDeploymentScenario,
): Promise<ProjectBinding | undefined> {
  const mappingRefs = scenario.mappingRefs.filter(isMappingRef)
  if (mappingRefs.length === 0 || mappingRefs.length !== scenario.mappingRefs.length) return undefined

  let profileRef: ResolvedProfileRef
  try {
    const scope = await client.getRunScope(scenario.profileRef)
    profileRef = {
      id: scenario.profileRef.id,
      version: scenario.profileRef.version,
      snapshotHash: scope.resolvedProfileHash,
    }
  } catch {
    return undefined
  }

  const digest = await webWorkspaceIdentity.sha256(
    JSON.stringify({ namespace: scenario.namespace, sources: scenario.rawSourceRefs }),
  )
  const documentSetRef: ResourceRef = {
    id: webWorkspaceIdentity.newId(),
    version: '1.0.0',
    digest,
    kind: 'artifact',
  }
  return { profileRef, mappingRefs, documentSetRef }
}
