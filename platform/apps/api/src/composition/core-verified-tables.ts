import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { answerDraftContentHash, canonicalJson, typedResultManifestContentDigest } from '@ontology/application'
import { isTypedResultManifest, sha256OfCanonical, tableManifestContentDigest } from '@ontology/contracts'
import type { AnswerStorePort, RunStore, TableVerificationReceiptStore, VerifiedTableManifestSource } from '@ontology/contracts'
import { ForbiddenError } from '../http/shared'

/** A registered table remains unreadable until its exact scoped answer has actually published. */
export function createCoreVerifiedTableSource(options: {
  readonly answers: Pick<AnswerStorePort, 'findByAnswer'>
  readonly runs: Pick<RunStore, 'getRun'>
  readonly tables: VerifiedTableManifestSource
  readonly receipts: TableVerificationReceiptStore
  readonly blobs: LocalImmutableBlobStore
}): VerifiedTableManifestSource {
  return { resolve: async (scope, answerId, tableId, ctx) => {
    const answer = await options.answers.findByAnswer(answerId, ctx)
    if (answer?.v3Body === undefined || answer.answerId !== answerId || answer.body !== undefined) return undefined
    const run = await options.runs.getRun(scope, answer.runId, ctx)
    if (run === undefined) return undefined
    if (run.ownerSubjectId !== ctx.principal.subjectId && !ctx.principal.roles.some((role) => ['platform-admin','operator','scoped-reader'].includes(role))) throw new ForbiddenError('only the run owner or a scoped reader may read the verified table')
    const body = answer.v3Body
    if (canonicalJson(body.limitations) !== canonicalJson(answer.limitations) || answerDraftContentHash(answer.runId, body.blocks, answer.evidenceManifestHash, body.claims, body.assertions, body) !== answer.contentHash) return undefined
    const meta = await options.blobs.getAuthorizedMetadata({ scopeRef: scope, blobRef: body.resultManifestRef }, ctx)
    if (meta.byteSize <= 0 || meta.byteSize > 8_388_608 || canonicalJson(meta.blobRef) !== canonicalJson(body.resultManifestRef) || meta.contentDigest !== body.resultManifestDigest || body.resultManifestRef.digest !== body.resultManifestDigest) return undefined
    const bytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: body.resultManifestRef }, ctx)
    const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!isTypedResultManifest(manifest) || typedResultManifestContentDigest(manifest) !== body.resultManifestDigest || canonicalJson(manifest.executionBindingRef) !== canonicalJson(body.executionBindingRef)) return undefined
    const matches = manifest.tables.filter((table) => table.tableId === tableId)
    const expected = matches[0]
    if (matches.length !== 1 || expected === undefined) return undefined
    const archived = await options.tables.resolve(scope, answerId, tableId, ctx)
    if (archived?.answerId !== answerId || archived.verificationReceiptRef === undefined || tableManifestContentDigest(archived.manifest) !== archived.ref.digest || canonicalJson(archived.manifest) !== canonicalJson(expected)) return undefined
    const actual = await options.receipts.getReceipt(scope, archived.verificationReceiptRef, ctx)
    const receipt = actual?.receipt
    if (actual === undefined || receipt === undefined || canonicalJson(actual.ref) !== canonicalJson(archived.verificationReceiptRef) || sha256OfCanonical(receipt) !== actual.ref.digest || receipt.draftHash !== answer.contentHash || receipt.tableId !== tableId ||
      canonicalJson(receipt.resultManifestRef) !== canonicalJson(archived.ref) || receipt.resultManifestDigest !== archived.ref.digest || receipt.expectedRows !== expected.totalRows || receipt.checkedRows !== receipt.expectedRows || receipt.expectedCells !== expected.totalRows * expected.columns.length || receipt.checkedCells !== receipt.expectedCells || canonicalJson(receipt.pageDigests) !== canonicalJson(expected.pages.map((page) => page.artifactDigest))) return undefined
    if (canonicalJson(await options.answers.findByAnswer(answerId, ctx)) !== canonicalJson(answer)) return undefined
    return archived
  } }
}
