import type { Namespace, ScopeRef, VersionRef } from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Few-shot example contracts (LOCAL-076, SPEC C3/C4, D7.1/D7.3, INV-03/INV-07).
 *
 * A few-shot example is a `(question → expected query shape)` pair that the SQL
 * proposer may be shown as a style hint. The examples live in a *versioned*
 * declaration owned by an industry pack or a published query-template set, never in
 * an ad-hoc per-run store, so every injected example is traceable to a version ref.
 *
 * The declaration is data only (INV-03): it carries concepts, fields and links — not
 * SQL text, a physical column, a connection address or a credential. That is also why
 * an example can never act as an executable template allowlist: it describes a semantic
 * shape, and the generated plan still passes the same parser/compiler validation as
 * every other proposal.
 *
 * The types live in `contracts` so both an industry pack (which imports `contracts`
 * alone) and the application layer can name them without either depending on the other.
 */

/** Where a versioned example set came from. Both are versioned, external declarations. */
export type FewShotExampleSourceKind = 'industry_pack_example_set' | 'published_query_template'

/**
 * A declarative semantic query shape. It deliberately has no SQL/`statement` field:
 * a pack scanner rejects SQL statement text, and keeping the shape semantic is what
 * stops an example from ever being executed or treated as a whitelisted template.
 */
export interface FewShotQueryShape {
  readonly concepts: readonly string[]
  readonly fields: readonly string[]
  readonly links?: readonly string[]
}

/** One example pair. `exampleId` is the stable key an indexed example document carries. */
export interface FewShotExample {
  readonly exampleId: string
  readonly question: string
  readonly expectedShape: FewShotQueryShape
}

/**
 * A versioned example set declared by an industry pack or a published template set.
 *
 * `collectionRef` names the authorized keyword-index collection the set is materialized
 * under. The materializer indexes each example as a document whose document ref id equals
 * `exampleId`, so a retrieval hit round-trips back to exactly one declared example and
 * undeclared indexed content is never injected.
 */
export interface FewShotExampleSet {
  readonly kind: FewShotExampleSourceKind
  readonly ref: VersionRef
  readonly namespace: Namespace
  readonly collectionRef: string
  readonly examples: readonly FewShotExample[]
}

/**
 * Resolves the versioned example sets configured for a scope/profile. The composition
 * root implements it from the resolved profile's industry pack and published query
 * templates; the application layer never imports a pack or a template store.
 */
export interface FewShotExampleSourceResolver {
  listExampleSets(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly FewShotExampleSet[]>
}
