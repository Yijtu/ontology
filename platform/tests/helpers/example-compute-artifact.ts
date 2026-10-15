import { readFileSync } from 'node:fs'
import type { ExampleComputeArtifactOptions } from '@ontology/tool-services'

export const exampleComputeArtifact: ExampleComputeArtifactOptions = {
  readArtifact: () => readFileSync(new URL(import.meta.resolve('@ontology/tool-services/compute/example-artifact'))),
}
