import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { PostgresEvidenceStore } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { createRunToolGateway } from '@ontology/tool-services'
import type {
  RunToolBinding,
  ToolGatewayDependencies,
  ToolHandler,
  ToolSchemaValidator,
} from '@ontology/tool-services'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  BudgetLedgerPort,
  ImmutableArtifactWriter,
  ToolContext,
  ToolGateway,
} from '@ontology/contracts'

/**
 * Composition root for the tool gateway (C4, C5).
 *
 * The gateway itself imports only `contracts`/`core`; the concrete driver-backed pieces
 * are wired here: the PostgreSQL evidence archive, the blob-backed immutable artifact
 * writer and the run's shared budget ledger. The schema validator and the registered
 * handlers are supplied by the caller, so `@ontology/tool-services` never imports a
 * schema library or a concrete backend.
 */
export interface ToolGatewayCompositionOptions {
  readonly database: ControlPostgresDatabase
  readonly blobStore: LocalImmutableBlobStore
  /** The run's single shared budget ledger (LOCAL-010). */
  readonly budget: BudgetLedgerPort
  readonly validator: ToolSchemaValidator
  readonly handlers: readonly ToolHandler[]
  readonly now?: () => string
  readonly newId?: () => string
}

export interface ToolGatewayComposition {
  readonly evidence: PostgresEvidenceStore
  readonly artifacts: ImmutableArtifactWriter
  /** Bind a gateway to exactly one run's ledger, resolved profile and operations. */
  forRun(binding: RunToolBinding): ToolGateway
}

/**
 * Archive bounded result bytes through the immutable, content-addressed blob store.
 *
 * `BlobPort.putImmutable` only declares an already-staged digest, so this adapter
 * bridges the write side: stage the bytes, verify them, then publish the reference.
 * A retry of the same bytes is idempotent because the object key is the content digest.
 */
export function createBlobArtifactWriter(blobStore: LocalImmutableBlobStore): ImmutableArtifactWriter {
  return {
    putBytes: async (
      request: ArtifactWriteRequest,
      ctx: ToolContext,
    ): Promise<BlobPutImmutableResponse> => {
      const staged = await blobStore.stage(request.content, { scopeRef: request.scopeRef }, ctx)
      return blobStore.publish(
        {
          scopeRef: request.scopeRef,
          contentDigest: staged.contentDigest,
          mediaType: request.mediaType,
          byteSize: staged.byteSize,
          purpose: 'large_result',
          ...(request.tenantAuthorizedRef === undefined
            ? {}
            : { tenantAuthorizedRef: request.tenantAuthorizedRef }),
        },
        ctx,
      )
    },
  }
}

export function createToolGatewayComposition(
  options: ToolGatewayCompositionOptions,
): ToolGatewayComposition {
  const evidence = new PostgresEvidenceStore(options.database)
  const artifacts = createBlobArtifactWriter(options.blobStore)
  const dependencies: ToolGatewayDependencies = {
    validator: options.validator,
    budget: options.budget,
    evidence,
    artifacts,
    handlers: options.handlers,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  }
  return {
    evidence,
    artifacts,
    forRun: (binding: RunToolBinding): ToolGateway => createRunToolGateway(dependencies, binding),
  }
}
