import type { GroundedSourceFragment, GroundedSource, ResourceRef, SourceGroundingPort } from '@ontology/contracts'
import { canonicalJson } from '../../extraction/canonical'

export type DefinitionGroundingFragment = GroundedSourceFragment

/** The model selects an index into real, read-back spans; it cannot mint a locator. */
export function groundingFragments(sources: readonly GroundedSource[]): DefinitionGroundingFragment[] {
  return sources.flatMap((source, sourceIndex) => {
    if (source.status === 'failed') return []
    let fragmentIndex = 0
    return source.contents.flatMap<DefinitionGroundingFragment>((content) => content.kind === 'text'
      ? [{ sourceIndex, fragmentIndex: fragmentIndex++, sourceRef: source.sourceRef,
          sourceSpan: content.sourceSpan, content: { kind: 'text', text: content.text } }]
      : content.rows.map((row) => ({ sourceIndex, fragmentIndex: fragmentIndex++, sourceRef: source.sourceRef,
          sourceSpan: row.sourceSpan, content: { kind: 'table', format: content.format,
            columns: content.columns, headerRow: content.headerRow, cells: row.cells } })))
  })
}

export function selectedGrounding(fragments: readonly DefinitionGroundingFragment[],
  sourceIndex: number | undefined, fragmentIndex: number | undefined): DefinitionGroundingFragment | undefined {
  if (sourceIndex === undefined || fragmentIndex === undefined) return undefined
  return fragments.find((fragment) => fragment.sourceIndex === sourceIndex && fragment.fragmentIndex === fragmentIndex)
}

export function sameResourcePin(left: ResourceRef, right: ResourceRef): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function groundingContext(read: Awaited<ReturnType<SourceGroundingPort['read']>>): string {
  return canonicalJson({ trust: 'untrusted_source_data', coverage: read.coverage,
    sources: read.sources.map((source, sourceIndex) => ({ sourceIndex, sourceRef: source.sourceRef,
      status: source.status, reasons: source.reasons,
      // Header-only tables still provide context, but there is no selectable fabricated row.
      headers: source.contents.filter((content) => content.kind === 'table').map((content) =>
        ({ columns: content.columns, headerRow: content.headerRow })),
      fragments: groundingFragments([source]).map((fragment) => ({ fragmentIndex: fragment.fragmentIndex,
        sourceSpan: fragment.sourceSpan, content: fragment.content })) })) })
}
