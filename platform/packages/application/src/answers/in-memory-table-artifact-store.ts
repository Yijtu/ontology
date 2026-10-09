import {
  assertTableArtifactManifestShape,
  assertTableArtifactPageBodyShape,
  isToolContext,
  tableArtifactContentDigest,
  sha256OfCanonical,
} from '@ontology/contracts'
import type {
  ArchivedTableArtifactManifest,
  NonEmptyString,
  ResourceRef,
  ScopeRef,
  TableArtifactManifest,
  TableArtifactManifestStore,
  TableArtifactPage,
  TableArtifactPageBody,
  TableArtifactPageStore,
  TableReadProgress,
  TableReadProgressStore,
  ToolContext,
  Uuid,
  VerifiedTableManifestSource,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}|${scopeRef.spaceId}`
}

function refKey(ref: ResourceRef): string {
  return `${ref.id}|${ref.version}|${ref.digest}`
}

function assertTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new Error('a host-minted trusted tool context is required')
  }
  if (
    ctx.principal.tenantId !== scopeRef.tenantId ||
    ctx.allowedResources.tenantId !== scopeRef.tenantId ||
    ctx.allowedResources.spaceId !== scopeRef.spaceId
  ) {
    throw new Error('request scope does not match the trusted principal scope')
  }
}

/**
 * In-memory implementation of the table artifact stores and the verified-manifest source.
 *
 * It exists for unit tests, local development and as a reference for the real adapter. The
 * page content digest is recomputed on write so a caller cannot store a page whose content
 * does not match the digest the manifest descriptor will fix. A table is only indexed for
 * read when a caller explicitly binds it to an answer via {@link indexVerifiedTable}; that
 * call omits the verification receipt when the table is only a raw unverified artifact, which
 * is exactly what the reader must refuse to render.
 */
export class InMemoryTableArtifactStore
  implements
    TableArtifactManifestStore,
    TableArtifactPageStore,
    TableReadProgressStore,
    VerifiedTableManifestSource
{
  readonly #manifests = new Map<string, ArchivedTableArtifactManifest>()
  readonly #byAnswerTable = new Map<string, ArchivedTableArtifactManifest>()
  readonly #pages = new Map<string, TableArtifactPage>()
  readonly #progress = new Map<string, TableReadProgress>()

  indexVerifiedTable(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    archived: ArchivedTableArtifactManifest,
  ): void {
    assertTableArtifactManifestShape(archived.manifest)
    this.#manifests.set(`${scopeKey(scopeRef)}|${refKey(archived.ref)}`, archived)
    this.#byAnswerTable.set(`${scopeKey(scopeRef)}|${answerId}|${tableId}`, archived)
  }

  async putManifest(
    scopeRef: ScopeRef,
    answerId: Uuid,
    manifestRef: ResourceRef,
    manifest: TableArtifactManifest,
    verificationReceiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<void> {
    assertTrustedScope(scopeRef, ctx)
    assertTableArtifactManifestShape(manifest)
    const archived: ArchivedTableArtifactManifest = { answerId, ref: manifestRef, manifest, verificationReceiptRef }
    const existing = this.#manifests.get(`${scopeKey(scopeRef)}|${refKey(manifestRef)}`)
    if (existing !== undefined && sha256OfCanonical(existing) !== sha256OfCanonical(archived)) throw new Error('the immutable table registration already belongs to another answer, receipt or body')
    this.#manifests.set(`${scopeKey(scopeRef)}|${refKey(manifestRef)}`, archived)
    this.#byAnswerTable.set(`${scopeKey(scopeRef)}|${answerId}|${manifest.tableId}`, archived)
  }

  async getManifest(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#manifests.get(`${scopeKey(scopeRef)}|${refKey(manifestRef)}`)
  }

  async putPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    body: TableArtifactPageBody,
    ctx: ToolContext,
  ): Promise<void> {
    assertTrustedScope(scopeRef, ctx)
    assertTableArtifactPageBodyShape(body)
    const contentDigest = tableArtifactContentDigest(body)
    if (pageRef.digest !== contentDigest) {
      throw new Error(`page ref digest ${pageRef.digest} does not match its content digest ${contentDigest}`)
    }
    this.#pages.set(`${scopeKey(scopeRef)}|${refKey(pageRef)}`, { ref: pageRef, body })
  }

  async getPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TableArtifactPage | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#pages.get(`${scopeKey(scopeRef)}|${refKey(pageRef)}`)
  }

  async get(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<TableReadProgress | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#progress.get(`${scopeKey(scopeRef)}|${answerId}|${tableId}`)
  }

  async save(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    progress: TableReadProgress,
    ctx: ToolContext,
  ): Promise<void> {
    assertTrustedScope(scopeRef, ctx)
    this.#progress.set(`${scopeKey(scopeRef)}|${answerId}|${tableId}`, progress)
  }

  async resolve(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#byAnswerTable.get(`${scopeKey(scopeRef)}|${answerId}|${tableId}`)
  }
}
