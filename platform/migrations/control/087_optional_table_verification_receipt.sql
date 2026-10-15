-- A raw table artifact may be retained before it earns formal verification.
-- The application reader refuses to serve such a registration while its receipt ref is absent.
ALTER TABLE agent_platform.table_result_manifests
  ALTER COLUMN verification_receipt_id DROP NOT NULL,
  ALTER COLUMN verification_receipt_version DROP NOT NULL,
  ALTER COLUMN verification_receipt_digest DROP NOT NULL;

ALTER TABLE agent_platform.table_result_manifests
  DROP CONSTRAINT IF EXISTS table_result_manifests_receipt_digest_format,
  ADD CONSTRAINT table_result_manifests_receipt_digest_format
    CHECK (verification_receipt_digest IS NULL OR verification_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT table_result_manifests_receipt_reference_complete
    CHECK (
      (verification_receipt_id IS NULL AND verification_receipt_version IS NULL AND verification_receipt_digest IS NULL)
      OR
      (verification_receipt_id IS NOT NULL AND verification_receipt_version IS NOT NULL AND verification_receipt_digest IS NOT NULL)
    );
