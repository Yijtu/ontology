import type {
  ToolContext,
  VersionRef,
  WebSearchProviderPage,
  WebSearchProviderRequest,
} from '@ontology/contracts'
import type { WebPageSnapshotArchiver } from './snapshot-archive'

/**
 * Archive one already-permitted search result behind the platform-controlled snapshot archiver
 * (design §6).
 *
 * Both providers (the native Tavily adapter and the compatibility HTTP gateway) share this
 * helper so "the original page bytes are archived by the platform, not the vendor" is one
 * implementation, not two drifting copies. The vendor summary is never treated as the page:
 *
 * - with no archiver the page is returned as a link only (`archive_not_configured`), never a fake
 *   snapshot;
 * - an archiver that retrieves the page returns the archived bytes' digest and the immutable
 *   snapshot/manifest refs, so the caller can cite and later read the real bytes;
 * - an archiver that cannot retrieve the page returns it as a link only with the explicit reason
 *   it reported.
 */
export async function archivePermittedPage(
  page: WebSearchProviderPage,
  request: WebSearchProviderRequest,
  ctx: ToolContext,
  archive: WebPageSnapshotArchiver | undefined,
  providerRef: VersionRef,
): Promise<WebSearchProviderPage> {
  if (archive === undefined) return { ...page, snapshotUnavailableReason: 'archive_not_configured' }

  const outcome = await archive.archive(
    {
      url: page.url,
      allowedDomains: request.allowedDomains,
      deadline: request.deadline,
      signal: request.signal,
      providerRef,
    },
    ctx,
  )
  if (outcome.status === 'discovery_only') {
    return { ...page, snapshotUnavailableReason: outcome.reason }
  }
  return {
    ...page,
    fetchedAt: outcome.fetchedAt,
    contentDigest: outcome.contentDigest,
    snapshotRef: outcome.snapshotRef,
    snapshotManifestRef: outcome.manifestRef,
    parserVersion: outcome.parserVersion,
    contentForm: outcome.contentForm,
    ...(outcome.parsedRef === undefined ? {} : { parsedRef: outcome.parsedRef }),
  }
}
