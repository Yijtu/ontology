# Registered compute build artifacts

`RegisteredComputeExecutionService` requires every handler to carry a verified artifact pin. Its
digest covers the emitted closed ESM bundle and the normalized source digests of the controlled
dependency closure. Version strings do not enter that calculation. The registered `handlerRef.digest`
and `handlerDigest` must agree; the task's `registeredOperationDigest` pins that entire record.

The example executes `artifacts/example.mjs`, not `example-handler.ts`. Run `pnpm run build:compute`
after changing its source or dependencies. `pnpm run lint` reproduces the build and refuses stale
bundle, manifest or declaration files. Build inputs are limited to explicitly allowed source roots;
package, builtin, external and unresolved runtime imports are rejected. No workspace/environment
scan, source map, timestamp or absolute build path enters the digest.
Publish a new deployment registration/version and task binding for changed code; the old record
must retain its original handler pin. Merely keeping its version label cannot authorize new code.

The trusted host pairs one finite static factory import with that artifact's manifest and byte reader:

```ts
const handlers = createArtifactComputeHandlers({
  manifest: deploymentManifest,
  readArtifact: hostArtifactReader,
  factory: staticallyImportedFactory,
})
```

The factory receives the verified handler digest and returns handlers for the deployment's finite
registered operation refs. The host must supply the factory exported by that exact static artifact;
this is a composition port, never a caller/model-supplied factory, path, source body or registration
DSL. Controlled customer domain functions belong inside the same build closure. Runtime artifacts,
input readers and writers remain injected ports; no customer quote service is called here.

The example helper requires `ExampleComputeArtifactOptions.readArtifact`. The API host reads the
public `@ontology/tool-services/compute/example-artifact` asset and passes that option to
`exampleRegisteredOperation`, `exampleOperationRegistry` and `createExampleComputeHandlers`.
Missing or inconsistent bytes fail closed during registration, fresh invocation and completed replay.
The service checks stored wrapper/bindings hashes and the invocation's registered operation pin before
returning a completed result. Handler metadata/manifest snapshots are frozen; changing supplied
manifest data after factory creation cannot replace the execution pin.

The shared execution signal is checked across handler, archive and replay phases and is passed to
terminal persistence. Cancellation before terminal commit rolls back that transition; a late complete
cannot resurrect a cancelled invocation. If commit already won the race, its completed record remains
immutable historical evidence, while the cancelled request still receives no successful compute
response or answer. The service does not reset the signal/deadline/budget or rewrite a committed
completion as a cancellation.

The existing non-task gateway dispatch keeps its existing registration behavior. Broader host
registration and gateway integration belongs to GAP-019; it should use this same trusted static
artifact/manifest/reader seam rather than manufacture label digests.
