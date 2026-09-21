-- 008_profile_composition.sql
--
-- Scenario composition store (SPEC C1/C6, D2; US-002/US-023). It keeps published
-- ProfileSpec versions, the resolved manifests a preflight produced and the single active
-- pointer per profile id.
--
-- A published profile version is immutable: the unique key is (profile_id, version) and
-- the digest is the frozen content value, so a binding change is a new version rather than
-- an overwrite. A resolved manifest is content-addressed by its snapshot hash and is never
-- rewritten, so a newer profile or component version leaves an earlier manifest
-- byte-identical.
--
-- The active pointer carries a monotonic revision; activation is a compare-and-set on it
-- (If-Match), never last-write-wins, and it references the exact resolved manifest it was
-- activated from.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the
-- application role access without another explicit GRANT. Forward-only: 001..007 are
-- never edited.

CREATE TABLE IF NOT EXISTS agent_platform.profile_versions (
  tenant_id   uuid        NOT NULL,
  space_id    uuid        NOT NULL,
  profile_id  text        NOT NULL,
  version     text        NOT NULL,
  digest      text        NOT NULL,
  environment text        NOT NULL,
  spec        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL,
  created_by  text        NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_versions_pkey PRIMARY KEY (tenant_id, space_id, profile_id, version),
  CONSTRAINT profile_versions_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT profile_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT profile_versions_environment
    CHECK (environment IN ('local_dev', 'ci', 'staging', 'production'))
);

-- Immutable, content-addressed resolved manifest. The snapshot hash pins exactly the
-- resolved set (exact versions/digests, resolved capabilities and explicit degradations).
-- The FK is RESTRICT so a profile version cannot be removed out from under a manifest.
CREATE TABLE IF NOT EXISTS agent_platform.resolved_profiles (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  profile_id       text        NOT NULL,
  version          text        NOT NULL,
  snapshot_hash    text        NOT NULL,
  output_version   text        NOT NULL,
  output_digest    text        NOT NULL,
  resolved_profile jsonb       NOT NULL,
  checked_at       timestamptz NOT NULL,
  resolved_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolved_profiles_pkey
    PRIMARY KEY (tenant_id, space_id, profile_id, version, snapshot_hash),
  CONSTRAINT resolved_profiles_version_fkey
    FOREIGN KEY (tenant_id, space_id, profile_id, version)
    REFERENCES agent_platform.profile_versions (tenant_id, space_id, profile_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT resolved_profiles_snapshot_format CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT resolved_profiles_output_digest_format CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$')
);

-- One active pointer per profile id. `revision` is the compare-and-set token the caller
-- supplies through If-Match; it only ever increases.
CREATE TABLE IF NOT EXISTS agent_platform.active_profiles (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  profile_id    text        NOT NULL,
  version       text        NOT NULL,
  snapshot_hash text        NOT NULL,
  revision      bigint      NOT NULL,
  activated_at  timestamptz NOT NULL,
  activated_by  text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT active_profiles_pkey PRIMARY KEY (tenant_id, space_id, profile_id),
  CONSTRAINT active_profiles_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT active_profiles_resolved_fkey
    FOREIGN KEY (tenant_id, space_id, profile_id, version, snapshot_hash)
    REFERENCES agent_platform.resolved_profiles
      (tenant_id, space_id, profile_id, version, snapshot_hash)
    ON DELETE RESTRICT,
  CONSTRAINT active_profiles_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS resolved_profiles_snapshot_idx
  ON agent_platform.resolved_profiles (tenant_id, space_id, profile_id, version);

ALTER TABLE agent_platform.profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.resolved_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.active_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.profile_versions;
CREATE POLICY scope_isolation ON agent_platform.profile_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.resolved_profiles;
CREATE POLICY scope_isolation ON agent_platform.resolved_profiles
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.active_profiles;
CREATE POLICY scope_isolation ON agent_platform.active_profiles
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
