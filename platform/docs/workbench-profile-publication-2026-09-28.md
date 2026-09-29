# Workbench profile publication (2026-09-28)

The Workbench keeps the existing preflight/activate flow when `baseProfileSpec` is omitted.
When a host supplies a base spec, an operator can enter a new SemVer and publish a copy of
that spec. Component selection only changes the copy: a runtime choice updates `runtimeRef`,
and a backend choice updates exactly one backend binding when the registered component's
capabilities identify one logical role and that role has one matching base mapping. The
matching `mappingRef` id is kept aligned with that mapping; `mappingRefs`, source objects,
credentials and other bindings are preserved.

The Workbench does not infer industry mappings. Selecting another industry pack blocks local
publication until the host supplies a corresponding base spec. A backend with ambiguous or
missing role/mapping relationships is also blocked. Otherwise the Workbench sends the new
version to `publishProfile`, preflights that exact returned ref, and activates it only when
preflight resolves. A failed publish, unresolved preflight, or If-Match conflict remains visible
with the attempted version pending; the activation callback fires only after activation
succeeds. Hosts can set `environment` (default `local_dev`) and receive the new ref through
`onProfileActivated`.

`tests/ui/workbench-publish.spec.ts` covers the real local API fixture over HTTP, including
publish → preflight → activate ordering, a role-mapped backend copy with preflight gaps,
unsupported industry/backend selections, publish failure, If-Match conflict, and the legacy
no-base-spec flow. It is component/API-fixture verification, not browser deployment acceptance.
