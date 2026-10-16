import type { Uuid } from '@ontology/contracts'
import { sha256DigestOf } from '../profiles/canonical'

/**
 * A deterministic, RFC 4122 v5-shaped uuid for one seed; the same seed always yields the
 * same id. The host-minted research identities (run, execution, ledger, manifest entries)
 * are all derived this way, so a replay of one logical request resolves to exactly one set
 * of identities rather than creating a duplicate.
 */
export function deterministicUuid(namespace: string, seed: string): Uuid {
  const digest = sha256DigestOf(`${namespace}:${seed}`).slice('sha256:'.length)
  const chars = [...digest.slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const joined = chars.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}` as Uuid
}

/**
 * The one budget ledger a workspace-research run owns, derived from its run id. The
 * admission opens it and every research usage point (search, archive paging, model
 * rounds, candidate command) reserves against it, so a run has exactly one ledger that a
 * replay/resume reuses instead of resetting.
 */
export function runBudgetLedgerId(runId: Uuid): Uuid {
  return deterministicUuid('run-budget-ledger', runId)
}
