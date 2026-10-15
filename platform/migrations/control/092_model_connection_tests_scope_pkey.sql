-- 092_model_connection_tests_scope_pkey.sql
--
-- Scope-correct the append-only probe audit primary key (design §2.7, §5.3; migrations README
-- rule 2: "Put `tenant_id`/`space_id` in every primary key and foreign key").
--
-- 090 created `model_connection_tests` with a global identity primary key `(test_id)` while the
-- tenant-owned invariant requires the key to carry the scope. The row values, RLS policy and the
-- `model_connection_tests_scope_idx` index are unchanged; only the primary key shape changes.
-- `090_model_connections.sql` is already applied elsewhere, so this is a new forward-only version
-- rather than an edit. The identity sequence is retained and inserts never supply `test_id`.

ALTER TABLE agent_platform.model_connection_tests
  DROP CONSTRAINT IF EXISTS model_connection_tests_pkey;

ALTER TABLE agent_platform.model_connection_tests
  ADD CONSTRAINT model_connection_tests_pkey PRIMARY KEY (tenant_id, space_id, test_id);
