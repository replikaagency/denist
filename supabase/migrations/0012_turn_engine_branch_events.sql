-- Append-only turn_engine.branch rows for operational dashboards (no input_summary / PII).
-- Populated server-side via service role; same pattern as conversation_events.

CREATE TABLE IF NOT EXISTS public.turn_engine_branch_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  branch_taken    text NOT NULL,
  current_step    text NOT NULL,
  allow_llm       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turn_engine_branch_events_branch_created_idx
  ON public.turn_engine_branch_events (branch_taken, created_at DESC);

CREATE INDEX IF NOT EXISTS turn_engine_branch_events_conversation_created_idx
  ON public.turn_engine_branch_events (conversation_id, created_at DESC);

COMMENT ON TABLE public.turn_engine_branch_events IS
  'Structured turn_engine.branch events for analytics. No patient text; branch ids only.';

ALTER TABLE public.turn_engine_branch_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Operational views (last 7 days; adjust in SQL editor or duplicate for 24h/30d)
-- ---------------------------------------------------------------------------
-- branch_taken values reference the canonical id list in:
--   codigo/src/lib/conversation/turn-engine-branches.ts
-- (Filters below match TurnEngineBranch namespaces / prefixes, not legacy phase or conversation_flow names.)

CREATE OR REPLACE VIEW public.turn_engine_top_branch_volume AS
SELECT
  branch_taken,
  count(*)::bigint AS event_count
FROM public.turn_engine_branch_events
WHERE created_at >= now() - interval '7 days'
GROUP BY branch_taken
ORDER BY event_count DESC;

CREATE OR REPLACE VIEW public.turn_engine_top_coordinator_yields AS
SELECT
  branch_taken,
  count(*)::bigint AS event_count
FROM public.turn_engine_branch_events
WHERE created_at >= now() - interval '7 days'
  AND branch_taken LIKE 'coordinator.yield%'
GROUP BY branch_taken
ORDER BY event_count DESC;

CREATE OR REPLACE VIEW public.turn_engine_top_llm_fallbacks AS
SELECT
  branch_taken,
  count(*)::bigint AS event_count
FROM public.turn_engine_branch_events
WHERE created_at >= now() - interval '7 days'
  AND branch_taken LIKE 'llm.%'
  AND (
    branch_taken = 'llm.call_failed'
    OR branch_taken LIKE 'llm.parse_recover%'
  )
GROUP BY branch_taken
ORDER BY event_count DESC;

-- Last turn_engine branch before each handoff (same conversation, timestamp <= handoff).
CREATE OR REPLACE VIEW public.turn_engine_top_branches_before_handoff AS
WITH last_branch AS (
  SELECT DISTINCT ON (h.id)
    h.id AS handoff_id,
    te.branch_taken
  FROM public.handoff_events h
  INNER JOIN public.turn_engine_branch_events te
    ON te.conversation_id = h.conversation_id
   AND te.created_at <= h.created_at
  WHERE h.created_at >= now() - interval '7 days'
  ORDER BY h.id, te.created_at DESC
)
SELECT
  branch_taken,
  count(*)::bigint AS handoff_count
FROM last_branch
GROUP BY branch_taken
ORDER BY handoff_count DESC;

COMMENT ON VIEW public.turn_engine_top_branch_volume IS
  'Top branch_taken by volume (7d).';
COMMENT ON VIEW public.turn_engine_top_coordinator_yields IS
  'Coordinator yield_* branches (7d).';
COMMENT ON VIEW public.turn_engine_top_llm_fallbacks IS
  'LLM call failures and parse-recovery paths (7d).';
COMMENT ON VIEW public.turn_engine_top_branches_before_handoff IS
  'Most common last branch before a handoff (7d).';
