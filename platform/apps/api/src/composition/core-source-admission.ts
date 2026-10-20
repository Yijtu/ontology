import { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ArtifactRegistry, ImmutableObjectStore } from '@ontology/adapter-blob-local'
import {
  deterministicUuid,
  LocalDocumentExtractionService,
  LocalStructuredIngestionService,
  publishGroundingDocumentSet,
  sha256DigestOfBytes,
} from '@ontology/adapter-extraction-document'
import type { DocumentArtifactStore, PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import type {
  ResourceRef,
  ScopeRef,
  SourceAdmissionBinding,
  SourceAdmissionContentPort,
  SourceAdmissionParserPort,
  SourceAdmissionSnapshot,
  SourceAdmissionTableOptions,
  ToolContext,
} from '@ontology/contracts'
import { SourceAdmissionError } from '@ontology/contracts'
import type { GroundingDocumentSetWriterPort } from '@ontology/contracts'

export interface CoreSourceAdmissionOptions {
  readonly blobs: LocalImmutableBlobStore
  readonly objectStore: ImmutableObjectStore
  readonly registry: ArtifactRegistry
  readonly parses: PostgresDocumentParseStore
  readonly structured: PostgresStructuredIngestionStore
}

const TABLE_MEDIA_TYPES: readonly string[] = [
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function tableOptionsOf(options: Omit<SourceAdmissionTableOptions, 'mediaType'> | undefined): SourceAdmissionTableOptions | undefined {
  if (options === undefined) return undefined
  return {
    ...(options.headerRow === undefined ? {} : { headerRow: options.headerRow }),
    ...(options.dataStartRow === undefined ? {} : { dataStartRow: options.dataStartRow }),
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
    ...(options.quote === undefined ? {} : { quote: options.quote }),
    ...(options.sheetId === undefined ? {} : { sheetId: options.sheetId }),
    ...(options.sheetName === undefined ? {} : { sheetName: options.sheetName }),
  }
}

/**
 * The composition-root implementation of the source-admission ports (design §2.2 steps ②/③/④):
 * an authorized byte readback, a logical document/parse binding and the immutable document-set
 * publisher. A candidate snapshot is an `artifact`; it is re-published as the `document` the corpus
 * is allowed to cite, never admitted as a raw artifact.
 */
export function createSourceAdmissionPorts(options: CoreSourceAdmissionOptions): {
  readonly content: SourceAdmissionContentPort
  readonly parser: SourceAdmissionParserPort
  readonly writer: GroundingDocumentSetWriterPort
} {
  const { blobs, objectStore, registry } = options

  const stableDocument = async (identity: string, bytes: Uint8Array, mediaType: string, ctx: ToolContext): Promise<ResourceRef> => {
    const scope = scopeOf(ctx)
    const id = deterministicUuid(`${scope.tenantId}|${scope.spaceId}|${identity}`)
    const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx)
    const readExisting = async (): Promise<ResourceRef | undefined> => {
      const found = await registry.findReference(scope, id)
      if (found === undefined) return undefined
      if (found.reference.purpose !== 'document' || found.reference.contentDigest !== staged.contentDigest) {
        throw new SourceAdmissionError('DIGEST_MISMATCH', 'the deterministic document id already names different source bytes')
      }
      const ref: ResourceRef = { id, version: '1.0.0', digest: staged.contentDigest, kind: 'document' }
      const actual = await blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
      if (actual.byteLength !== bytes.byteLength) throw new SourceAdmissionError('DIGEST_MISMATCH', 'the existing document failed byte readback')
      return ref
    }
    const existing = await readExisting()
    if (existing !== undefined) return existing
    const writer = new LocalImmutableBlobStore({ objectStore, registry, idFactory: () => id })
    try {
      const published = await writer.publish(
        { scopeRef: scope, contentDigest: staged.contentDigest, byteSize: bytes.byteLength, mediaType, purpose: 'document' },
        ctx,
      )
      return published.blobRef
    } catch (cause) {
      const concurrent = await readExisting()
      if (concurrent !== undefined) return concurrent
      throw cause
    }
  }

  const content: SourceAdmissionContentPort = {
    async readPinned(scope, input, ctx): Promise<SourceAdmissionSnapshot> {
      let metadata: Awaited<ReturnType<DocumentArtifactStore['getAuthorized']>>
      try {
        metadata = await blobs.getAuthorized({ scopeRef: scope, blobRef: input.contentRef }, ctx)
      } catch (cause) {
        throw new SourceAdmissionError('MISSING_ORIGINAL', 'the authorized original is unavailable', { cause })
      }
      if (metadata.contentDigest !== input.contentDigest) {
        throw new SourceAdmissionError('DIGEST_MISMATCH', 'the pinned snapshot digest does not match its metadata')
      }
      let bytes: Uint8Array
      try {
        bytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: input.contentRef }, ctx)
      } catch (cause) {
        throw new SourceAdmissionError('MISSING_ORIGINAL', 'the authorized original is unavailable', { cause })
      }
      if (bytes.byteLength === 0) throw new SourceAdmissionError('EMPTY_SOURCE', 'the pinned snapshot has no bytes')
      if (sha256DigestOfBytes(bytes) !== input.contentDigest) {
        throw new SourceAdmissionError('DIGEST_MISMATCH', 'the pinned snapshot bytes do not match their digest')
      }
      return { mediaType: metadata.mediaType, byteSize: bytes.byteLength, bytes }
    },
  }

  const parser: SourceAdmissionParserPort = {
    async bind(input, ctx): Promise<SourceAdmissionBinding> {
      const scope = scopeOf(ctx)
      const digest = sha256DigestOfBytes(input.bytes)
      // A reviewed source that already pins a readable `document` keeps that identity: admission is
      // not a second document. Re-minting a deterministic id for the same bytes would make the
      // admitted source ref differ from the ref every candidate already cites, so a candidate could
      // never be re-grounded against the corpus it was actually built from (R09).
      const documentRef = input.contentRef.kind === 'document'
        ? input.contentRef
        : await stableDocument(`source-document:${digest}`, input.bytes, input.mediaType, ctx)
      if (TABLE_MEDIA_TYPES.includes(input.mediaType)) {
        const parsed = await new LocalStructuredIngestionService({ blobs, store: options.structured })
          .parse({ scopeRef: scope, originalRef: documentRef, options: input.parseOptions ?? {} }, ctx)
        const coverage = parsed.parse.status === 'complete' ? 'complete'
          : parsed.parse.status === 'incomplete' ? 'partial' : 'failed'
        const tableOptions = tableOptionsOf(parsed.parse.parseOptions)
        return {
          kind: 'table',
          sourceRef: parsed.parse.originalRef,
          parseId: parsed.parse.parseId,
          parserVersion: parsed.parse.parserVersion,
          coverage,
          ...(tableOptions === undefined ? {} : { tableOptions }),
        }
      }
      const parsed = await new LocalDocumentExtractionService({ blobs, store: options.parses })
        .parse({ scopeRef: scope, originalRef: documentRef, documentVersionRef: documentRef }, ctx)
      return {
        kind: 'document',
        sourceRef: parsed.originalRef,
        parseId: parsed.parseId,
        parserVersion: parsed.parserVersion,
        coverage: parsed.coverage.status,
      }
    },
  }

  const writer: GroundingDocumentSetWriterPort = {
    publish: (_scope, manifest, ctx) => publishGroundingDocumentSet(blobs, manifest, ctx),
  }

  return { content, parser, writer }
}
