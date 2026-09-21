/**
 * @ontology/adapter-extraction-document — real document parsing with traceable spans.
 *
 * Parsing reads an immutable original through an injected artifact store, writes
 * the normalized text and the span map as separate content-addressed artifacts,
 * and persists structure-aware chunks so a later search backend can index them
 * without re-parsing. The original is never rewritten.
 */
export { DocumentExtractionError } from './errors'
export type { DocumentExtractionErrorCode } from './errors'

export {
  DEFAULT_PARSER_VERSION,
  DOCUMENT_PARSER_ID,
  LocalDocumentExtractionService,
  SPAN_MAP_MEDIA_TYPE,
} from './service'
export type { LocalDocumentExtractionDependencies } from './service'

export {
  NORMALIZED_TEXT_MEDIA_TYPE,
  buildNormalizedTextArtifact,
  parseNormalizedTextArtifact,
} from './normalized-artifact'
export type { NormalizedTextArtifact } from './normalized-artifact'

export { DocumentSpanReader } from './span-reader'
export type { DocumentSpanReaderDependencies } from './span-reader'

export { InMemoryDocumentParseStore } from './memory-store'
export { PostgresDocumentParseStore } from './postgres-store'
export type { PostgresDocumentParseStoreConfig } from './postgres-store'

export {
  buildChunkRecords,
  chunkLines,
  isConditionLine,
  isExceptionLine,
  isTableRow,
} from './chunker'
export type { BuildChunkContext, ChunkOptions } from './chunker'

export { extractDocument, mediaKindOf } from './extract'
export type { ExtractOptions } from './extract'

export { sha256DigestOfBytes, sha256DigestOfText, deterministicUuid } from './hashing'

export type {
  DocumentArtifactPublishRequest,
  DocumentArtifactStageRequest,
  DocumentArtifactStageResult,
  DocumentArtifactStore,
  DraftChunk,
  ExtractedText,
  OcrPageInput,
  OcrPageResult,
  OcrTextProvider,
  StructuralLine,
} from './types'
