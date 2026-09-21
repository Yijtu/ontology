-- 012_jobs_outbox.sql
--
-- Durable background jobs, attempts, leases, stage checkpoints, exactly-once publication
-- and the transactional outbox (SPEC D6/C6, US-009/US-011, FR-10/11/13).
--
-- Design:
--  * `jobs` is the logical job: stable identity (tenant/space + source/document version +
--    pipeline version), current stage, queryable counts, classified last error and the
--    monotonic `revision` behind If-Match. `(tenant_id, space_id, idempotency_key)` is the
--    Idempotency-Key claim and `(tenant_id, space_id, input_digest)` is the content-derived
--    logical identity, so the same input/pipeline reuses one logical job.
--  * `job_attempts` is one execution. A retry creates a new attempt of the same logical job;
--    an expired lease marks the attempt `abandoned` and a later claim creates a new attempt.
--    `(tenant_id, space_id, job_id, attempt_number)` is unique, and the retry idempotency key
--    is unique per job so a replayed retry never creates a second attempt.
--  * `job_stage_checkpoints` makes each `(job, stage)` advance idempotent: the unique key
--    rejects a second apply after a crash, so counts and outbox rows are never duplicated.
--  * `job_publications` is the exactly-once publication key: the unique `(job, publication_key)`
--    makes a re-run after a crash insert nothing.
--  * `job_outbox` holds side effects written in the same transaction as the state change;
--    dispatch is at-least-once and the consumer is idempotent by `idempotency_key`.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the application
-- role access without another explicit GRANT. Forward-only: 001..011 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.jobs (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  job_id                  uuid        NOT NULL,
  kind                    text        NOT NULL,
  source_ref              text        NOT NULL,
  document_ref            text,
  dataset_ref             text,
  pipeline_version        text        NOT NULL,
  stage                   text        NOT NULL,
  failed_stage            text,
  idempotency_key         text        NOT NULL,
  input_digest            text        NOT NULL,
  revision                bigint      NOT NULL,
  attempt_count           integer     NOT NULL DEFAULT 0,
  abandoned_attempt_count integer     NOT NULL DEFAULT 0,
  counts                  jsonb       NOT NULL,
  last_error              jsonb,
  next_attempt_at         timestamptz NOT NULL,
  publication_id          uuid,
  publication_version_ref jsonb,
  published_at            timestamptz,
  created_at              timestamptz NOT NULL,
  created_by              text        NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT jobs_pkey PRIMARY KEY (tenant_id, space_id, job_id),
  CONSTRAINT jobs_idempotency_key_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT jobs_input_digest_unique UNIQUE (tenant_id, space_id, input_digest),
  CONSTRAINT jobs_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT jobs_revision_positive CHECK (revision > 0),
  CONSTRAINT jobs_attempt_count_non_negative CHECK (attempt_count >= 0 AND abandoned_attempt_count >= 0),
  CONSTRAINT jobs_input_digest_format CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT jobs_input_present CHECK (document_ref IS NOT NULL OR dataset_ref IS NOT NULL),
  CONSTRAINT jobs_kind CHECK (kind IN ('ingestion', 'simulation')),
  CONSTRAINT jobs_stage CHECK (stage IN (
    'received', 'parsed', 'extracted', 'validated', 'awaiting_review',
    'published', 'failed', 'cancelled', 'rejected'
  )),
  CONSTRAINT jobs_failed_stage CHECK (failed_stage IS NULL OR failed_stage IN (
    'received', 'parsed', 'extracted', 'validated'
  )),
  CONSTRAINT jobs_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON agent_platform.jobs (tenant_id, space_id, stage, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS agent_platform.job_attempts (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  job_id           uuid        NOT NULL,
  attempt_id       uuid        NOT NULL,
  attempt_number   integer     NOT NULL,
  state            text        NOT NULL,
  stage            text        NOT NULL,
  worker_id        text,
  lease_expires_at timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  abandoned_reason text,
  error            jsonb,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_attempts_pkey PRIMARY KEY (tenant_id, space_id, job_id, attempt_id),
  CONSTRAINT job_attempts_number_unique UNIQUE (tenant_id, space_id, job_id, attempt_number),
  CONSTRAINT job_attempts_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_attempts_state CHECK (state IN (
    'pending', 'leased', 'running', 'succeeded', 'failed', 'abandoned'
  )),
  CONSTRAINT job_attempts_stage CHECK (stage IN (
    'received', 'parsed', 'extracted', 'validated', 'awaiting_review',
    'published', 'failed', 'cancelled', 'rejected'
  )),
  CONSTRAINT job_attempts_number_positive CHECK (attempt_number > 0)
);

-- One attempt per retry key: a replayed POST /jobs/{id}/retry returns the existing attempt.
CREATE UNIQUE INDEX IF NOT EXISTS job_attempts_retry_key_unique
  ON agent_platform.job_attempts (tenant_id, space_id, job_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS job_attempts_lease_idx
  ON agent_platform.job_attempts (tenant_id, space_id, state, lease_expires_at);

-- Idempotent stage checkpoint. A unique (job, stage) means a crash after the stage commit
-- cannot apply the stage twice when a new attempt resumes.
CREATE TABLE IF NOT EXISTS agent_platform.job_stage_checkpoints (
  tenant_id    uuid        NOT NULL,
  space_id     uuid        NOT NULL,
  job_id       uuid        NOT NULL,
  stage        text        NOT NULL,
  attempt_id   uuid        NOT NULL,
  counts       jsonb       NOT NULL,
  created_at   timestamptz NOT NULL,
  CONSTRAINT job_stage_checkpoints_pkey PRIMARY KEY (tenant_id, space_id, job_id, stage),
  CONSTRAINT job_stage_checkpoints_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_stage_checkpoints_stage CHECK (stage IN (
    'received', 'parsed', 'extracted', 'validated', 'awaiting_review', 'published'
  ))
);

-- Exactly-once publication. The unique (job, publication_key) makes a re-run after a crash
-- insert nothing.
CREATE TABLE IF NOT EXISTS agent_platform.job_publications (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  job_id          uuid        NOT NULL,
  publication_id  uuid        NOT NULL,
  publication_key text        NOT NULL,
  version_ref     jsonb       NOT NULL,
  version_digest  text        NOT NULL,
  published_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_publications_pkey PRIMARY KEY (tenant_id, space_id, job_id, publication_id),
  CONSTRAINT job_publications_key_unique UNIQUE (tenant_id, space_id, job_id, publication_key),
  CONSTRAINT job_publications_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_publications_version_digest_format CHECK (version_digest ~ '^sha256:[0-9a-f]{64}$')
);

-- Transactional outbox. Written in the same transaction as the state change; dispatched
-- at-least-once with an idempotent consumer keyed by `idempotency_key`.
CREATE TABLE IF NOT EXISTS agent_platform.job_outbox (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  outbox_id       uuid        NOT NULL,
  job_id          uuid        NOT NULL,
  topic           text        NOT NULL,
  payload         jsonb       NOT NULL,
  idempotency_key text        NOT NULL,
  state           text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  available_at    timestamptz NOT NULL,
  dispatched_at   timestamptz,
  created_at      timestamptz NOT NULL,
  CONSTRAINT job_outbox_pkey PRIMARY KEY (tenant_id, space_id, outbox_id),
  CONSTRAINT job_outbox_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT job_outbox_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_outbox_state CHECK (state IN ('pending', 'dispatched'))
);

CREATE INDEX IF NOT EXISTS job_outbox_dispatch_idx
  ON agent_platform.job_outbox (tenant_id, space_id, state, available_at, created_at);

ALTER TABLE agent_platform.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.job_stage_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.job_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.job_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.jobs;
CREATE POLICY scope_isolation ON agent_platform.jobs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.job_attempts;
CREATE POLICY scope_isolation ON agent_platform.job_attempts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.job_stage_checkpoints;
CREATE POLICY scope_isolation ON agent_platform.job_stage_checkpoints
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.job_publications;
CREATE POLICY scope_isolation ON agent_platform.job_publications
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.job_outbox;
CREATE POLICY scope_isolation ON agent_platform.job_outbox
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
