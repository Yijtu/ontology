import type { TaskKind } from '@ontology/contracts'

/**
 * The single source of truth mapping a mounted task kind to the public tool it reaches through
 * the gateway. Every composition site (task listing, semantic planning, run request) reads this
 * table instead of re-deriving the mapping, so a new task kind is declared once.
 */
export function coreTaskToolId(kind: TaskKind): 'ontology_lookup' | 'data_query' | 'document_search' {
  switch (kind) {
    case 'structured_query':
    case 'compute':
      return 'data_query'
    case 'document_qa':
      return 'document_search'
    case 'published_facts':
    case 'rule_judgement':
    case 'relations':
      return 'ontology_lookup'
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled task kind ${String(exhaustive)}`)
    }
  }
}
