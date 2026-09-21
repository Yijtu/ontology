import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPutImmutableResponse,
  DocumentChunkRecord,
  DocumentMediaKind,
  DocumentPageRecord,
  OffsetUnit,
  ParseCoverage,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'

/**
 * The immutable-artifact capability the parser needs. It is declared structurally
 * so the composition root can pass `LocalImmutableBlobStore` (or any other
 * implementation of the same contract) without this adapter importing another
 * adapter — the architecture boundary forbids adapter → adapter imports.
 */
export interface DocumentArtifactStageRequest {
  readonly scopeRef: ScopeRef
}

export interface DocumentArtifactStageResult {
  readonly contentDigest: Sha256Digest
  readonly byteSize: number
}

export interface DocumentArtifactPublishRequest {
  readonly scopeRef: ScopeRef
  readonly contentDigest: Sha256Digest
  readonly mediaType: string
  readonly byteSize: number
  readonly tenantAuthorizedRef?: string
  /** `document` keeps the original; `artifact` marks derived parse output. */
  readonly purpose: 'document' | 'artifact'
  readonly origin?: Readonly<Record<string, unknown>>
}

export interface DocumentArtifactStore {
  stage(
    content: Uint8Array,
    request: DocumentArtifactStageRequest,
    ctx: ToolContext,
  ): Promise<DocumentArtifactStageResult>
  publish(
    request: DocumentArtifactPublishRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse>
  getAuthorized(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse>
  readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
}

/** A page image handed to an OCR provider. */
export interface OcrPageInput {
  readonly page: number
  /** Digest of the immutable original; a real provider renders the page from it. */
  readonly originalDigest: Sha256Digest
  readonly mediaType: string
}

/**
 * OCR result. `approximate` is always true: OCR text cannot be located exactly
 * in the source, so a caller must mark the spans it produces as approximate.
 */
export interface OcrPageResult {
  readonly text: string
  readonly approximate: true
  readonly providerId: string
}

/**
 * OCR capability. The default implementation is `UnavailableOcrProvider`, which
 * refuses instead of inventing text. Tests inject a deterministic scripted
 * provider; that is a simulation of the OCR path, not a real OCR engine, and the
 * parse record says so.
 */
export interface OcrTextProvider {
  recognize(input: OcrPageInput, ctx: ToolContext): Promise<OcrPageResult>
}

/** One reconstructed visual line with its source location. */
export interface StructuralLine {
  readonly text: string
  readonly page: number
  readonly startOffset: number
  readonly endOffset: number
  readonly headingLevel?: number
  readonly fontSize?: number
}

/** What a media-specific extractor produces before chunking. */
export interface ExtractedText {
  readonly mediaKind: DocumentMediaKind
  readonly offsetUnit: OffsetUnit
  readonly normalizedText: string
  readonly lines: readonly StructuralLine[]
  readonly pages: readonly DocumentPageRecord[]
  readonly coverage: ParseCoverage
  readonly notes: readonly string[]
}

/** A chunk before ids/digests are assigned. */
export interface DraftChunk {
  readonly chunkKind: DocumentChunkRecord['chunkKind']
  readonly heading?: string
  readonly text: string
  readonly page: number
  readonly startOffset: number
  readonly endOffset: number
  readonly precision: DocumentChunkRecord['precision']
  readonly conditions: readonly string[]
  readonly exceptions: readonly string[]
  readonly caption?: string
  readonly tableHeader?: string
  readonly parentOrdinal?: number
}


