import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { RUNNABLE_JOB_STAGES } from '@ontology/contracts'
import type { ScopeRef } from '@ontology/contracts'

/**
 * The drain check that gates the S11 removal of the legacy research chain (design §10).
 *
 * S10 switched newly-accepted research to the V2 agentic run; historical `@1` request-carrying
 * jobs (the legacy environment `1.0.0` job and the catalogue `1.1.0` job) were still executed by
 * the fixed chain. S11 retires that chain, so an in-flight request-carrying job would be stranded.
 * Before this build accepts traffic it proves there is nothing left to strand: no queued/running
 * request-carrying research job, no effective lease on one, no recoverable checkpoint that a
 * reclaimed attempt would resume from, and no unreconciled budget usage held on one.
 *
 * A historical record that has **already collected its material and is waiting for a human**
 * (the job stopped at a terminal/stop stage, the execution at `awaiting_confirmation`) is *not* a
 * task that still needs to run; it is preserved for reading and never blocks the upgrade.
 *
 * The check is read-only and scope-isolated (RLS plus the explicit tenant/space predicates). It is
 * deliberately conservative: any signal means the operator must first finish or explicitly cancel
 * the work with the original compatible engine — this build never rebuilds a "same binding" it
 * cannot prove and never reassigns such a job to the agentic runtime.
 */

/** The request-carrying research job pipeline versions: the legacy env job and the S03 catalogue job. */
export const LEGACY_RESEARCH_PIPELINE_VERSIONS: readonly string[] = ['1.0.0', '1.1.0']

export type LegacyResearchDrainReason =
  | 'queued_or_running_job'
  | 'effective_lease'
  | 'recoverable_checkpoint'
  | 'unreconciled_usage'

export interface LegacyResearchDrainFinding {
  readonly reason: LegacyResearchDrainReason
  readonly jobId: string
  readonly detail: string
}

export interface LegacyResearchDrainReport {
  /** True when no request-carrying research job is still in flight for this scope. */
  readonly drained: boolean
  readonly findings: readonly LegacyResearchDrainFinding[]
}

/** Raised at host startup when a request-carrying research job is still in flight. */
export class LegacyResearchInFlightError extends Error {
  readonly code = 'LEGACY_RESEARCH_IN_FLIGHT' as const
  readonly findings: readonly LegacyResearchDrainFinding[]

  constructor(findings: readonly LegacyResearchDrainFinding[]) {
    const summary = findings
      .map((finding) => `${finding.reason}:${finding.jobId}`)
      .join(', ')
    super(
      `the legacy research chain is retired but ${String(findings.length)} request-carrying research job(s) are still in flight (${summary}); finish or explicitly cancel them with the original engine before upgrading`,
    )
    this.name = 'LegacyResearchInFlightError'
    this.findings = findings
  }
}

interface JobRow {
  readonly job_id: string
  readonly stage: string
  readonly pipeline_version: string
}

interface AttemptRow {
  readonly attempt_id: string
  readonly job_id: string
  readonly state: string
}

interface CheckpointRow {
  readonly job_id: string
  readonly stage: string
}

interface LedgerRow {
  readonly ledger_id: string
  readonly reservation_id: string | null
  readonly status: string | null
}

/**
 * Inspect the durable control stores for in-flight request-carrying research work in one scope.
 * It never writes and never throws for a data reason: an unreadable store is a real failure and is
 * propagated, so the caller cannot mistake an outage for "drained".
 */
export async function inspectLegacyResearchDrain(
  database: ControlPostgresDatabase,
  scopeRef: ScopeRef,
): Promise<LegacyResearchDrainReport> {
  const versions = [...LEGACY_RESEARCH_PIPELINE_VERSIONS]
  const runnable = [...RUNNABLE_JOB_STAGES]
  const findings = await database.withIdentityScope(scopeRef, async (client) => {
    const collected: LegacyResearchDrainFinding[] = []

    const jobs = await client.query<JobRow>(
      `SELECT job_id::text AS job_id, stage, pipeline_version
         FROM agent_platform.jobs
        WHERE tenant_id = $1::uuid AND space_id = $2::uuid
          AND kind = 'research'
          AND pipeline_version = ANY($3::text[])
          AND stage = ANY($4::text[])
        ORDER BY created_at`,
      [scopeRef.tenantId, scopeRef.spaceId, versions, runnable],
    )
    for (const row of jobs.rows) {
      collected.push({ reason: 'queued_or_running_job', jobId: row.job_id, detail: `${row.pipeline_version}@${row.stage}` })
    }

    const attempts = await client.query<AttemptRow>(
      `SELECT a.attempt_id::text AS attempt_id, a.job_id::text AS job_id, a.state
         FROM agent_platform.job_attempts a
         JOIN agent_platform.jobs j
           ON j.tenant_id = a.tenant_id AND j.space_id = a.space_id AND j.job_id = a.job_id
        WHERE a.tenant_id = $1::uuid AND a.space_id = $2::uuid
          AND j.kind = 'research'
          AND j.pipeline_version = ANY($3::text[])
          AND a.state IN ('leased', 'running')
          AND (a.lease_expires_at IS NULL OR a.lease_expires_at > now())`,
      [scopeRef.tenantId, scopeRef.spaceId, versions],
    )
    for (const row of attempts.rows) {
      collected.push({ reason: 'effective_lease', jobId: row.job_id, detail: `${row.state}:${row.attempt_id}` })
    }

    const checkpoints = await client.query<CheckpointRow>(
      `SELECT c.job_id::text AS job_id, c.stage
         FROM agent_platform.job_stage_checkpoints c
         JOIN agent_platform.jobs j
           ON j.tenant_id = c.tenant_id AND j.space_id = c.space_id AND j.job_id = c.job_id
        WHERE c.tenant_id = $1::uuid AND c.space_id = $2::uuid
          AND j.kind = 'research'
          AND j.pipeline_version = ANY($3::text[])
          AND j.stage = ANY($4::text[])`,
      [scopeRef.tenantId, scopeRef.spaceId, versions, runnable],
    )
    for (const row of checkpoints.rows) {
      collected.push({ reason: 'recoverable_checkpoint', jobId: row.job_id, detail: row.stage })
    }

    const ledgers = await client.query<LedgerRow>(
      `SELECT l.ledger_id::text AS ledger_id, r.reservation_id::text AS reservation_id, r.status
         FROM agent_platform.budget_ledgers l
         JOIN agent_platform.jobs j
           ON j.tenant_id = l.tenant_id AND j.space_id = l.space_id AND j.job_id = l.ledger_id
         LEFT JOIN agent_platform.budget_reservations r
           ON r.tenant_id = l.tenant_id AND r.space_id = l.space_id AND r.ledger_id = l.ledger_id
        WHERE l.tenant_id = $1::uuid AND l.space_id = $2::uuid
          AND l.kind = 'background'
          AND j.kind = 'research'
          AND j.pipeline_version = ANY($3::text[])
          AND (r.status IN ('reserved', 'running', 'usage_unknown') OR r.usage_unknown = true)`,
      [scopeRef.tenantId, scopeRef.spaceId, versions],
    )
    for (const row of ledgers.rows) {
      collected.push({ reason: 'unreconciled_usage', jobId: row.ledger_id, detail: `${row.status ?? 'unknown'}:${row.reservation_id ?? 'ledger'}` })
    }

    return collected
  })
  return { drained: findings.length === 0, findings }
}

/** Assert that no request-carrying research job is in flight, throwing a stable error otherwise. */
export async function assertLegacyResearchDrained(
  database: ControlPostgresDatabase,
  scopeRef: ScopeRef,
): Promise<void> {
  const report = await inspectLegacyResearchDrain(database, scopeRef)
  if (!report.drained) throw new LegacyResearchInFlightError(report.findings)
}
