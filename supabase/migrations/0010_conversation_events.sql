-- Append-only lifecycle events for analytics and pilot observability.
-- Written only from server (service role); not exposed to patient-facing RLS.

CREATE TABLE IF NOT EXISTS public.conversation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  event_type      text NOT NULL,
  source          text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_events_conversation_created_idx
  ON public.conversation_events (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_events_event_type_created_idx
  ON public.conversation_events (event_type, created_at DESC);

ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;
