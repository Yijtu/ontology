# Verification semantic-state integration (2026-09-28)

`DraftVerificationService` delegates immutable state creation to the injected
`DecisionStateRefProvider`; it does not manufacture a reference from the draft hash or write
the state itself. The local application API is:

```ts
interface DecisionStateRefProvider {
  archive(
    input: {
      runId: Uuid
      resolvedProfileHash: Sha256Digest
      state: unknown
    },
    ctx: ToolContext,
  ): Promise<ResourceRef>
}
```

The provider must persist the exact JSON state immutably and authorize the returned artifact
reference for that run and resolved profile before returning it. The application verification
barrel exports this provider type. The host's state resolver
must check that registration against the trusted `ToolContext` before reading any blob bytes.
The decision-state registration is separate from the workflow input manifest: semantic review
does not add the snapshot to that manifest. The artifact digest must be the canonical JSON
SHA-256 digest used by the JEV adapter's actual-state resolver.

The verifier builds `verification-semantic-state@1` from the original user question, run and
profile identity, current draft hash, manifest identity, typed claims and assertions, and the
evidence each claim references. A resolved evidence item includes its recorded envelope and
the payload already read by hard verification. Missing, mismatched, or unreadable evidence is
represented with an explicit availability value; it is never replaced by an opaque claim ID or
described as readable. `state` is typed `unknown` at the provider boundary so this layer does
not depend on an adapter SDK; the host writer must canonicalize and reject non-JSON state.

The JEV `DecisionPort` is the sole owner of model-attempt reservation and settlement. The
verifier makes one decision request per claim against the same immutable state ref and does no
parallel budget reservation. A repaired draft produces a fresh state snapshot and reference
while continuing to use the run's existing budget ledger. Provider or decision-port errors,
including cancellation, deadline, evidence-recording, and budget-settlement failures, propagate
to the caller and cannot become a successful verification result.

`VerificationResult.semanticReview` records whether review completed or did not run. Disabled
review, no claims, missing configuration, and an explicit JEV fallback are distinguished. With
the deterministic unavailable policy, hard checks remain authoritative and a hard-clean draft
may pass with `semanticReview: { status: 'not_run', ... }`; with the clarify policy, the verifier
adds `semantic_unavailable`, which prevents a pass even when the semantic axis is optional.

## Host integration contract

- Compose a provider backed by the immutable artifact writer and the run/profile decision-state
  registry; check trusted run/profile scope before registration and return only after both writes
  succeed.
- Configure the JEV resolver to require that registry entry before metadata lookup or blob read.
- Inject the same run budget ledger into JEV so each actual HTTP attempt is charged by the
  adapter once.

The verifier unit tests and controlled local HTTP adapter tests do not establish normal HTTP
host wiring, durable registration recovery, or a real paid-provider call. Those require separate
host and persistence acceptance.
