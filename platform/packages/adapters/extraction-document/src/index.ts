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
export { StructuredPremiseSourceReader } from './structured/premise-source'
export type { StructuredPremiseSourceReaderDependencies } from './structured/premise-source'
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
  truncatedChunkIdsOf,
} from './chunker'
export type { BuildChunkContext, ChunkOptions } from './chunker'

export { extractDocument, mediaKindOf } from './extract'
export type { ExtractOptions } from './extract'

export { sha256DigestOfBytes, sha256DigestOfText, deterministicUuid } from './hashing'

export {
  STRUCTURED_PARSER_ID,
  STRUCTURED_PARSER_VERSION,
  StructuredDocumentParser,
} from './structured'

export {
  LocalStructuredIngestionService,
  reconcileStructuredResult,
} from './structured/ingest-service'
export type { LocalStructuredIngestionDependencies } from './structured/ingest-service'
export { PostgresStructuredIngestionStore } from './structured/ingest-postgres-store'
export type { PostgresStructuredIngestionStoreConfig } from './structured/ingest-postgres-store'
export { InMemoryStructuredIngestionStore } from './structured/ingest-memory-store'
export { StructuredIngestionError } from './structured/ingest-errors'
export type { StructuredIngestionErrorCode } from './structured/ingest-errors'

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
export * from './source-grounding'
export { StructuredDocumentProjectionService, StructuredDocumentSpanReader, STRUCTURED_PROJECTION_VERSION, STRUCTURED_PROJECTION_MAX_ROWS, STRUCTURED_PROJECTION_MAX_MAP_BYTES } from './structured/document-projection'
export type { StructuredDocumentProjectionDependencies, StructuredProjectionOrigin } from './structured/document-projection'
