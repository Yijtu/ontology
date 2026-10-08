import { readFileSync } from 'node:fs'
import type { ExampleComputeArtifactOptions } from '@ontology/tool-services'

/** Finite host-owned asset paired with the service's static factory import; never request input. */
export const exampleComputeArtifact: ExampleComputeArtifactOptions = {
  readArtifact: () => readFileSync(new URL(import.meta.resolve('@ontology/tool-services/compute/example-artifact'))),
}
