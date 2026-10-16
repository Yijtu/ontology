-- 104_research_budget_dimensions.sql
--
-- Research dimensions on the one shared ledger (design §8, node S06).
--
-- The shared budget ledger (011) tracked the classic tool/row/byte/model-token units. A
-- bounded agentic research run also spends public searches, model rounds, discovered
-- sources, proposed candidates and downloaded/read bytes, and all of those must
-- accumulate on the *same* ledger row as the classic counters so a retry, an archive
-- page, a resume or a second write command can never buy more of any dimension.
--
-- This migration is purely additive: it adds the six dimension columns to
-- `budget_ledgers` (consumed totals) and to `budget_reservations` (reserved + actual),
-- each `NOT NULL DEFAULT 0` (or nullable for the actual_* reconciliation columns) so
-- every existing row and every existing background/ingestion ledger keeps its current
-- behaviour with the new dimensions simply at zero.
--
-- `budget_reservations`'s amount check is replaced so a negative reservation is still
-- impossible after the new columns exist; the ledger totals get one check per column.
--
-- Forward-only: migrations 001..103 are never edited (this file only ALTERs tables they
-- created). Every key already carries tenant_id/space_id, so the new columns inherit the
-- existing RLS policies and keys.

ALTER TABLE agent_platform.budget_ledgers
  ADD COLUMN IF NOT EXISTS searches_consumed       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model_rounds_consumed   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sources_consumed        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_consumed     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS download_bytes_consumed bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS read_bytes_consumed     bigint  NOT NULL DEFAULT 0;

ALTER TABLE agent_platform.budget_ledgers
  DROP CONSTRAINT IF EXISTS budget_ledgers_research_nonnegative;
ALTER TABLE agent_platform.budget_ledgers
  ADD CONSTRAINT budget_ledgers_research_nonnegative CHECK (
    searches_consumed >= 0 AND model_rounds_consumed >= 0
    AND sources_consumed >= 0 AND candidates_consumed >= 0
    AND download_bytes_consumed >= 0 AND read_bytes_consumed >= 0
  );

ALTER TABLE agent_platform.budget_reservations
  ADD COLUMN IF NOT EXISTS searches               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model_rounds           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sources                integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates             integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_download_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_read_bytes     bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_searches        integer,
  ADD COLUMN IF NOT EXISTS actual_model_rounds    integer,
  ADD COLUMN IF NOT EXISTS actual_sources         integer,
  ADD COLUMN IF NOT EXISTS actual_candidates      integer,
  ADD COLUMN IF NOT EXISTS actual_download_bytes  bigint,
  ADD COLUMN IF NOT EXISTS actual_read_bytes      bigint;

-- Replace the original amount check so it also covers the six new reserved dimensions.
ALTER TABLE agent_platform.budget_reservations
  DROP CONSTRAINT IF EXISTS budget_reservations_amounts_nonnegative;
ALTER TABLE agent_platform.budget_reservations
  ADD CONSTRAINT budget_reservations_amounts_nonnegative CHECK (
    tool_calls >= 0 AND repair_attempts >= 0 AND parallel_tools >= 0
    AND reserved_rows >= 0 AND reserved_bytes >= 0 AND reserved_model_tokens >= 0
    AND searches >= 0 AND model_rounds >= 0 AND sources >= 0 AND candidates >= 0
    AND reserved_download_bytes >= 0 AND reserved_read_bytes >= 0
  );
