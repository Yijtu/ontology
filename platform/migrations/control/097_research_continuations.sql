-- 097_research_continuations.sql
--
-- Research continuations (design §3/§10, node R10).
--
-- An ended research run cannot be revived in place (its terminal write is fenced); a user may
-- instead append a **new** research execution grounded in the products the previous run left
-- behind. The new run keeps its own authorization, budget and id, and records the run it
-- continues through `continued_from` so a reader can follow the chain without rewriting the
-- frozen predecessor. The link is nullable and informational: it never reuses the predecessor's
-- binding, budget or candidates.
--
-- Forward-only: earlier migrations are never edited. The self foreign key keeps the link inside
-- the same tenant/space scope, and the column is nullable so every existing @1 record stays valid.

ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS continued_from uuid;

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_continued_from_fkey;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_continued_from_fkey
    FOREIGN KEY (tenant_id, space_id, continued_from)
    REFERENCES agent_platform.workspace_research_runs (tenant_id, space_id, research_id);

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_continued_from_not_self;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_continued_from_not_self
    CHECK (continued_from IS NULL OR continued_from <> research_id);
