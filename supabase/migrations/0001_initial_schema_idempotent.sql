-- =============================================================================
-- Dental Reception AI — Initial Schema (IDEMPOTENT VERSION)
-- Safe to run multiple times — skips anything that already exists.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enum types (wrapped to skip if already exist)
-- ---------------------------------------------------------------------------

DO $$ BEGIN CREATE TYPE public.conversation_channel AS ENUM ('web_chat','sms','email','whatsapp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.conversation_status AS ENUM ('active','waiting_human','human_active','resolved','abandoned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.message_role AS ENUM ('patient','ai','human','system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.lead_status AS ENUM ('new','contacted','qualified','appointment_requested','booked','lost','disqualified'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.appointment_type AS ENUM ('new_patient','checkup','emergency','whitening','implant_consult','orthodontic_consult','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.appointment_request_status AS ENUM ('pending','confirmed','cancelled','no_show','completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.handoff_reason AS ENUM ('patient_request','ai_escalation','complex_query','complaint','emergency','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contacts (
  id              uuid        primary key default gen_random_uuid(),
  email           text        unique,
  phone           text        unique,
  first_name      text,
  last_name       text,
  is_new_patient  boolean     not null default true,
  insurance_provider text,
  session_token   text        unique not null default gen_random_uuid()::text,
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id                  uuid        primary key default gen_random_uuid(),
  contact_id          uuid        not null references public.contacts (id) on delete cascade,
  status              public.lead_status not null default 'new',
  source              text,
  treatment_interest  text[]      not null default '{}',
  notes               text,
  assigned_to         uuid,
  qualified_at        timestamptz,
  lost_at             timestamptz,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (contact_id)
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id               uuid        primary key default gen_random_uuid(),
  contact_id       uuid        not null references public.contacts (id) on delete cascade,
  lead_id          uuid        references public.leads (id) on delete set null,
  channel          public.conversation_channel not null default 'web_chat',
  status           public.conversation_status  not null default 'active',
  ai_enabled       boolean     not null default true,
  summary          text,
  last_message_at  timestamptz,
  metadata         jsonb       not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references public.conversations (id) on delete cascade,
  role             public.message_role not null,
  content          text        not null,
  model            text,
  tokens_used      integer     check (tokens_used >= 0),
  finish_reason    text,
  latency_ms       integer     check (latency_ms >= 0),
  metadata         jsonb       not null default '{}',
  created_at       timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.appointment_requests (
  id                  uuid        primary key default gen_random_uuid(),
  contact_id          uuid        not null references public.contacts (id) on delete cascade,
  conversation_id     uuid        references public.conversations (id) on delete set null,
  lead_id             uuid        references public.leads (id) on delete set null,
  appointment_type    public.appointment_type not null default 'new_patient',
  status              public.appointment_request_status not null default 'pending',
  preferred_date      date,
  preferred_time_of_day text      check (preferred_time_of_day in ('morning','afternoon','evening','any')),
  preferred_days      text[]      not null default '{}',
  notes               text,
  confirmed_at        timestamptz,
  confirmed_datetime  timestamptz,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.handoff_events (
  id                  uuid        primary key default gen_random_uuid(),
  conversation_id     uuid        not null references public.conversations (id) on delete cascade,
  contact_id          uuid        not null references public.contacts (id) on delete cascade,
  reason              public.handoff_reason not null default 'other',
  trigger_message_id  uuid        references public.messages (id) on delete set null,
  assigned_to         uuid,
  resolved_at         timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (IF NOT EXISTS)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_contacts_session_token  ON public.contacts (session_token);
CREATE INDEX IF NOT EXISTS idx_contacts_email          ON public.contacts (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_phone          ON public.contacts (phone) WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_contact_id       ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status           ON public.conversations (status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at  ON public.conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_channel          ON public.conversations (channel);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON public.messages (conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_leads_status      ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id  ON public.leads (contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON public.leads (assigned_to) WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appt_req_contact_id ON public.appointment_requests (contact_id);
CREATE INDEX IF NOT EXISTS idx_appt_req_status     ON public.appointment_requests (status);
CREATE INDEX IF NOT EXISTS idx_appt_req_conv_id    ON public.appointment_requests (conversation_id);
CREATE INDEX IF NOT EXISTS idx_appt_req_created_at ON public.appointment_requests (created_at DESC);

-- Deduplication: at most one open (pending or confirmed) request per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_req_one_open_per_conv
  ON public.appointment_requests (conversation_id)
  WHERE status IN ('pending', 'confirmed')
    AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_handoff_conversation_id ON public.handoff_events (conversation_id);
CREATE INDEX IF NOT EXISTS idx_handoff_assigned_to     ON public.handoff_events (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_handoff_resolved_at     ON public.handoff_events (resolved_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- updated_at trigger function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON public.contacts;
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leads_updated_at ON public.leads;
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON public.conversations;
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_appointment_requests_updated_at ON public.appointment_requests;
CREATE TRIGGER trg_appointment_requests_updated_at BEFORE UPDATE ON public.appointment_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_handoff_events_updated_at ON public.handoff_events;
CREATE TRIGGER trg_handoff_events_updated_at BEFORE UPDATE ON public.handoff_events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_events     ENABLE ROW LEVEL SECURITY;

-- Policies (drop + recreate to be idempotent)
DROP POLICY IF EXISTS "staff_read_all" ON public.contacts;
CREATE POLICY "staff_read_all" ON public.contacts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_read_all" ON public.leads;
CREATE POLICY "staff_read_all" ON public.leads FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_read_all" ON public.conversations;
CREATE POLICY "staff_read_all" ON public.conversations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_read_all" ON public.messages;
CREATE POLICY "staff_read_all" ON public.messages FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_read_all" ON public.appointment_requests;
CREATE POLICY "staff_read_all" ON public.appointment_requests FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_read_all" ON public.handoff_events;
CREATE POLICY "staff_read_all" ON public.handoff_events FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_write_leads" ON public.leads;
CREATE POLICY "staff_write_leads" ON public.leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "staff_write_appointment_requests" ON public.appointment_requests;
CREATE POLICY "staff_write_appointment_requests" ON public.appointment_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "staff_write_handoff_events" ON public.handoff_events;
CREATE POLICY "staff_write_handoff_events" ON public.handoff_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Anon RLS: patient chat realtime (messages)
--
-- The patient chat widget subscribes to postgres_changes on `messages` as an
-- unauthenticated (anon) user. Without an anon SELECT policy, Supabase
-- Realtime silently drops all events, so staff replies never appear in the
-- patient chat without a page refresh.
--
-- A SECURITY DEFINER function checks that the message's conversation_id maps
-- to a real conversation row, without granting anon direct access to the
-- conversations table. See migration 0003 for full rationale.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.anon_can_read_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversations
    WHERE id = p_conversation_id
  );
$$;

REVOKE ALL ON FUNCTION public.anon_can_read_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anon_can_read_conversation(uuid) TO anon;

DROP POLICY IF EXISTS "anon_read_messages_for_conversation" ON public.messages;
CREATE POLICY "anon_read_messages_for_conversation"
  ON public.messages
  FOR SELECT
  TO anon
  USING (public.anon_can_read_conversation(conversation_id));

-- ---------------------------------------------------------------------------
-- Supabase Realtime — enable postgres_changes for key tables
-- Required for useRealtimeConversations and useRealtimeMessages hooks.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
