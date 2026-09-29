# Published answer body component

`apps/web/src/components/PublishedAnswerBody.tsx` renders a `PublishedAnswer` without
displaying model-authored free prose. The Core workbench can mount it where a published
answer is shown and optionally supply semantic labels and an evidence-navigation callback:

```tsx
<PublishedAnswerBody
  answer={answer}
  resolveLabel={(id, kind) => deploymentLabels.get(`${kind}:${id}`)}
  onEvidenceReference={(ref) => openAuthorizedEvidence(ref)}
/>
```

The callback receives the complete evidence `ResourceRef`; the component does not construct
URLs or expose evidence IDs in the visible source label. Without a deployment label, the
stable subject or predicate ID is shown.

For `answer-draft@2`, only exact `{ kind, claimId }` and `{ kind, assertionId }` blocks that
resolve to structurally valid typed claims/assertions with at least one valid evidence
binding are rendered. Quantity strings are shown verbatim with their declared units. Boolean
`false` remains an explicit “否”; the rule-judgement row is labelled as a rule judgement and
not as a business conclusion. Quote text is inserted as React text, preserving the source
characters while escaping markup.

Unknown blocks, extra prose fields, missing typed items, and missing evidence bindings are
omitted with a visible notice. V1 free prose is omitted; the known legacy summary may show
only its evidence count. A metadata-only legacy answer explicitly says its body is
unavailable. History-limited answers show their `asOf` time, and limitation codes map to
plain explanations; unrecognized codes are identified as restrictions rather than business
statements. IDs and hashes remain in a disclosure section.

The offline jsdom suite is `tests/ui/published-answer-body.spec.ts` and can be run with:

```powershell
pnpm exec vitest run tests/ui/published-answer-body.spec.ts
```

These tests cover typed values and source callbacks, quote escaping, unsupported blocks,
missing refs, rule/business distinction, legacy bodies, historical time, and unknown
limitations. They do not exercise the Core `QueryPanel` wiring or a real browser/API answer
route; those remain for the host integration and browser acceptance work.
