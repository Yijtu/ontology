-- 001_control_foundation.sql
--
-- Control storage foundation (SPEC D1/D2, D8 batch 001).
--
-- Forward-only migration, applied by the explicit migration step
-- (`runControlMigrations`, exposed as `pnpm --filter @ontology/adapter-control-postgres
-- migrate:control`). Service startup never runs migrations.
--
-- Every tenant-owned table carries tenant_id/space_id in its primary key and in
-- every foreign key, so a row can never cross a tenant or a space boundary.

CREATE SCHEMA IF NOT EXISTS agent_platform;

CREATE TABLE IF NOT EXISTS agent_platform.tenants (
  tenant_id  uuid        NOT NULL,
  slug       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_pkey PRIMARY KEY (tenant_id),
  CONSTRAINT tenants_slug_key UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS agent_platform.spaces (
  tenant_id  uuid        NOT NULL,
  space_id   uuid        NOT NULL,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spaces_pkey PRIMARY KEY (tenant_id, space_id),
  CONSTRAINT spaces_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES agent_platform.tenants (tenant_id) ON DELETE CASCADE
);

-- Per (tenant, space, stream) monotonic sequence. AppendEvent locks this row so
-- concurrent appends to one stream cannot reuse a recorded_seq.
CREATE TABLE IF NOT EXISTS agent_platform.event_streams (
  tenant_id  uuid        NOT NULL,
  space_id   uuid        NOT NULL,
  stream_ref text        NOT NULL,
  last_seq   bigint      NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_streams_pkey PRIMARY KEY (tenant_id, space_id, stream_ref),
  CONSTRAINT event_streams_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT event_streams_last_seq_nonnegative CHECK (last_seq >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.semantic_events (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  stream_ref      text        NOT NULL,
  recorded_seq    bigint      NOT NULL,
  payload_digest  text        NOT NULL,
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_events_pkey PRIMARY KEY (tenant_id, space_id, stream_ref, recorded_seq),
  CONSTRAINT semantic_events_idempotency_key UNIQUE (tenant_id, space_id, stream_ref, idempotency_key),
  CONSTRAINT semantic_events_stream_fkey FOREIGN KEY (tenant_id, space_id, stream_ref)
    REFERENCES agent_platform.event_streams (tenant_id, space_id, stream_ref) ON DELETE CASCADE,
  CONSTRAINT semantic_events_seq_positive CHECK (recorded_seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.projection_state (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  projection_ref  text        NOT NULL,
  generation      bigint      NOT NULL DEFAULT 0,
  watermark_kind  text        NOT NULL DEFAULT 'opaque',
  watermark_value text        NOT NULL DEFAULT '',
  dirty           boolean     NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projection_state_pkey PRIMARY KEY (tenant_id, space_id, projection_ref),
  CONSTRAINT projection_state_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT projection_state_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT projection_state_watermark_kind
    CHECK (watermark_kind IN ('sequence', 'timestamp', 'opaque'))
);
