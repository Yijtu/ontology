-- 032_identity_decisions.sql
--
-- Entity identity decisions and reversible identity records (SPEC D4.5/D4.6, C6,
-- US-014/US-015, FR-14/16/17).
--
-- Design:
--  * `identity_decisions` is append-only: every revision is a distinct immutable row and
--    `(tenant_id, space_id, candidate_id, revision)` is unique. A revision never overwrites
--    the previous version, so a reviewer can always read the earlier decision, its
--    evidence, actor and valid interval.
--  * `identity_decision_heads` is the compare-and-swap counter behind If-Match. A row is
--    locked `FOR UPDATE` while a decision is appended, so two concurrent decisions cannot
--    both pass the same `expectedRevision`; the loser is a revision conflict.
--  * `identity_entities` holds the canonical (or pending) entity a decision creates. Its
--    object/identity scope is what blocks a `device`/`sensor` merge even when the names are
--    identical.
--  * `identity_assertions` is the time-bounded merge membership. A `split` sets `valid_to`
--    instead of deleting the row, so the earlier binding stays auditable and a reversal does
--    not erase history that other evidence still supports.
--  * `identity_link_constraints` is the hard `cannot_link` negative link; it blocks a merge
--    and is never silently dropped.
--  * a `split` writes its downstream invalidation message to the real transactional
--    `job_outbox` in the same transaction, so a dependent conclusion cannot be silently
--    kept after the merge it relied on is reversed.
--
-- Every key carries tenant_id/space_id and RLS denies rows outside the session scope.
-- Appended after 003, so default privileges grant the application role. Forward-only:
-- 001..031 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.identity_entities (
  tenant_id         uuid        NOT NULL,
  space_id          uuid        NOT NULL,
  entity_id         text        NOT NULL,
  object_id         text        NOT NULL,
  identity_scope_id text        NOT NULL,
  display_name      text,
  state             text        NOT NULL,
  revision          bigint      NOT NULL DEFAULT 1,
  recorded_at       timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT identity_entities_pkey PRIMARY KEY (tenant_id, space_id, entity_id),
  CONSTRAINT identity_entities_state CHECK (state IN ('pending', 'confirmed', 'retired')),
  CONSTRAINT identity_entities_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS identity_entities_scope_idx
  ON agent_platform.identity_entities (tenant_id, space_id, object_id, identity_scope_id);

CREATE TABLE IF NOT EXISTS agent_platform.identity_decision_heads (
  tenant_id    uuid   NOT NULL,
  space_id     uuid   NOT NULL,
  candidate_id uuid   NOT NULL,
  revision     bigint NOT NULL DEFAULT 0,
  CONSTRAINT identity_decision_heads_pkey PRIMARY KEY (tenant_id, space_id, candidate_id),
  CONSTRAINT identity_decision_heads_revision_non_negative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.identity_decisions (
  tenant_id              uuid        NOT NULL,
  space_id               uuid        NOT NULL,
  decision_id            uuid        NOT NULL,
  candidate_id           uuid        NOT NULL,
  object_id              text        NOT NULL,
  identity_scope_id      text        NOT NULL,
  kind                   text        NOT NULL,
  revision               bigint      NOT NULL,
  target_entity_id       text,
  separated_candidate_ids jsonb,
  evidence_refs          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  justification          text,
  strong_identity        jsonb,
  score_evidence         jsonb,
  valid_from             timestamptz,
  valid_to               timestamptz,
  recorded_at            timestamptz NOT NULL,
  actor                  text        NOT NULL,
  supersedes_revision    bigint,
  invalidation_outbox_id uuid,
  CONSTRAINT identity_decisions_pkey PRIMARY KEY (tenant_id, space_id, decision_id),
  CONSTRAINT identity_decisions_revision_unique UNIQUE (tenant_id, space_id, candidate_id, revision),
  CONSTRAINT identity_decisions_kind CHECK (kind IN ('match', 'create_pending', 'clarify', 'reject', 'split')),
  CONSTRAINT identity_decisions_revision_positive CHECK (revision > 0),
  -- Half-open `[valid_from, valid_to)`; equality is the empty interval an immediate
  -- correction produces, and must not be rejected.
  CONSTRAINT identity_decisions_valid_range CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS identity_decisions_candidate_idx
  ON agent_platform.identity_decisions (tenant_id, space_id, candidate_id, revision);

CREATE TABLE IF NOT EXISTS agent_platform.identity_assertions (
  tenant_id         uuid        NOT NULL,
  space_id          uuid        NOT NULL,
  assertion_id      uuid        NOT NULL,
  candidate_id      uuid        NOT NULL,
  entity_id         text        NOT NULL,
  object_id         text        NOT NULL,
  identity_scope_id text        NOT NULL,
  decision_id       uuid        NOT NULL,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL,
  CONSTRAINT identity_assertions_pkey PRIMARY KEY (tenant_id, space_id, assertion_id),
  CONSTRAINT identity_assertions_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS identity_assertions_entity_idx
  ON agent_platform.identity_assertions (tenant_id, space_id, entity_id, valid_to);

CREATE INDEX IF NOT EXISTS identity_assertions_candidate_idx
  ON agent_platform.identity_assertions (tenant_id, space_id, candidate_id, valid_to);

CREATE TABLE IF NOT EXISTS agent_platform.identity_link_constraints (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  constraint_id uuid        NOT NULL,
  candidate_id  uuid        NOT NULL,
  entity_id     text        NOT NULL,
  kind          text        NOT NULL,
  decision_id   uuid        NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CONSTRAINT identity_link_constraints_pkey PRIMARY KEY (tenant_id, space_id, constraint_id),
  CONSTRAINT identity_link_constraints_unique UNIQUE (tenant_id, space_id, candidate_id, entity_id, kind),
  CONSTRAINT identity_link_constraints_kind CHECK (kind IN ('cannot_link'))
);

ALTER TABLE agent_platform.identity_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.identity_decision_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.identity_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.identity_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.identity_link_constraints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_entities;
CREATE POLICY scope_isolation ON agent_platform.identity_entities
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_decision_heads;
CREATE POLICY scope_isolation ON agent_platform.identity_decision_heads
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_decisions;
CREATE POLICY scope_isolation ON agent_platform.identity_decisions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_assertions;
CREATE POLICY scope_isolation ON agent_platform.identity_assertions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_link_constraints;
CREATE POLICY scope_isolation ON agent_platform.identity_link_constraints
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
