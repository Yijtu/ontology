import type { ComputeBuildArtifactManifest } from '@ontology/tool-services'
export declare function buildComputeArtifact(options: {
  root: string
  entryPoint: string
  allowedSourceRoots: readonly string[]
}): Promise<{ content: Uint8Array; manifest: ComputeBuildArtifactManifest }>
