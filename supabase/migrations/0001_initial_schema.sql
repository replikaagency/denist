-- =============================================================================
-- Dental Reception AI — Initial Schema
-- =============================================================================
-- Run against your Supabase project via:
--   supabase db push
-- or paste into the Supabase SQL editor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

create type public.conversation_channel as enum (
  'web_chat',
  'sms',
  'email',
  'whatsapp'
);

create type public.conversation_status as enum (
  'active',          -- AI is handling
  'waiting_human',   -- handoff requested, no staff assigned yet
  'human_active',    -- staff member is in the conversation
  'resolved',        -- conversation closed
  'abandoned'        -- patient left without resolution
);

create type public.message_role as enum (
  'patient',
  'ai',
  'human',   -- sent by a staff member during handoff
  'system'   -- internal notes, never shown to patient
);

create type public.lead_status as enum (
  'new',
  'contacted',
  'qualified',
  'appointment_requested',
  'booked',
  'lost',
  'disqualified'
);

create type public.appointment_type as enum (
  'new_patient',
  'checkup',
  'emergency',
  'whitening',
  'implant_consult',
  'orthodontic_consult',
  'other'
);

create type public.appointment_request_status as enum (
  'pending',
  'confirmed',
  'cancelled',
  'no_show',
  'completed'
);

create type public.handoff_reason as enum (
  'patient_request',
  'ai_escalation',
  'complex_query',
  'complaint',
  'emergency',
  'other'
);

-- ---------------------------------------------------------------------------
-- contacts
-- The canonical record for anyone who contacts the practice.
-- May start anonymous and be enriched as the AI collects information.
-- ---------------------------------------------------------------------------
create table public.contacts (
  id              uuid        primary key default gen_random_uuid(),
  email           text        unique,
  phone           text        unique,
  first_name      text,
  last_name       text,
  is_new_patient  boolean     not null default true,
  insurance_provider text,
  -- session_token links an anonymous browser session to this contact
  -- before name/email are collected.  Rotated once the contact is identified.
  session_token   text        unique not null default gen_random_uuid()::text,
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.contacts is
  'Any person who has reached out via any channel. Anonymous initially.';
comment on column public.contacts.session_token is
  'Opaque token stored in the browser to re-identify an anonymous visitor.';

-- ---------------------------------------------------------------------------
-- leads
-- CRM record tracking the sales/conversion funnel for a contact.
-- One lead per contact (enforced by unique constraint).
-- ---------------------------------------------------------------------------
create table public.leads (
  id                  uuid        primary key default gen_random_uuid(),
  contact_id          uuid        not null references public.contacts (id) on delete cascade,
  status              public.lead_status not null default 'new',
  source              text,                          -- 'web_chat' | 'google_ad' | 'referral' etc.
  treatment_interest  text[]      not null default '{}',  -- ['whitening','implants']
  notes               text,
  assigned_to         uuid,                          -- references auth.users (staff)
  qualified_at        timestamptz,
  lost_at             timestamptz,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (contact_id)
);

comment on table public.leads is
  'CRM funnel record. Created automatically when a contact is first identified.';

-- ---------------------------------------------------------------------------
-- conversations
-- A single chat session on a given channel.
-- ---------------------------------------------------------------------------
create table public.conversations (
  id               uuid        primary key default gen_random_uuid(),
  contact_id       uuid        not null references public.contacts (id) on delete cascade,
  lead_id          uuid        references public.leads (id) on delete set null,
  channel          public.conversation_channel not null default 'web_chat',
  status           public.conversation_status  not null default 'active',
  ai_enabled       boolean     not null default true,
  -- AI-generated running summary, updated periodically to compress context.
  summary          text,
  last_message_at  timestamptz,
  metadata         jsonb       not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.conversations is
  'A single patient chat session. Contacts can have multiple conversations.';

-- ---------------------------------------------------------------------------
-- messages
-- Individual turns within a conversation.
-- ---------------------------------------------------------------------------
create table public.messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references public.conversations (id) on delete cascade,
  role             public.message_role not null,
  content          text        not null,
  -- AI-specific metadata (populated only when role = 'ai')
  model            text,
  tokens_used      integer     check (tokens_used >= 0),
  finish_reason    text,       -- 'stop' | 'length' | 'tool_calls' | 'content_filter'
  latency_ms       integer     check (latency_ms >= 0),
  metadata         jsonb       not null default '{}',
  created_at       timestamptz not null default now()
  -- messages are immutable; no updated_at
);

comment on table public.messages is
  'Immutable log of all turns in a conversation.';

-- ---------------------------------------------------------------------------
-- appointment_requests
-- Structured record created when the AI detects appointment intent.
-- ---------------------------------------------------------------------------
create table public.appointment_requests (
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
  confirmed_datetime  timestamptz,  -- the actual booked slot once confirmed by staff
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.appointment_requests is
  'Structured appointment request created by AI when patient indicates booking intent.';

-- ---------------------------------------------------------------------------
-- handoff_events
-- Audit log for every AI → human escalation.
-- ---------------------------------------------------------------------------
create table public.handoff_events (
  id                  uuid        primary key default gen_random_uuid(),
  conversation_id     uuid        not null references public.conversations (id) on delete cascade,
  contact_id          uuid        not null references public.contacts (id) on delete cascade,
  reason              public.handoff_reason not null default 'other',
  trigger_message_id  uuid        references public.messages (id) on delete set null,
  assigned_to         uuid,       -- references auth.users (staff member who picks it up)
  resolved_at         timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.handoff_events is
  'Every AI-to-human escalation. Drives the staff inbox.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- contacts: look up by session token on every chat message
create index idx_contacts_session_token  on public.contacts (session_token);
create index idx_contacts_email          on public.contacts (email) where email is not null;
create index idx_contacts_phone          on public.contacts (phone) where phone is not null;

-- conversations: patient history + admin dashboard filters
create index idx_conversations_contact_id       on public.conversations (contact_id);
create index idx_conversations_status           on public.conversations (status);
create index idx_conversations_last_message_at  on public.conversations (last_message_at desc);
create index idx_conversations_channel          on public.conversations (channel);

-- messages: ordered history fetch (most common query)
create index idx_messages_conversation_created
  on public.messages (conversation_id, created_at asc);

-- leads: CRM dashboard filters
create index idx_leads_status      on public.leads (status);
create index idx_leads_contact_id  on public.leads (contact_id);
create index idx_leads_assigned_to on public.leads (assigned_to) where assigned_to is not null;

-- appointment_requests: staff queue
create index idx_appt_req_contact_id on public.appointment_requests (contact_id);
create index idx_appt_req_status     on public.appointment_requests (status);
create index idx_appt_req_conv_id    on public.appointment_requests (conversation_id);
create index idx_appt_req_created_at on public.appointment_requests (created_at desc);

-- handoff_events: staff inbox + open handoffs
create index idx_handoff_conversation_id on public.handoff_events (conversation_id);
create index idx_handoff_assigned_to     on public.handoff_events (assigned_to) where assigned_to is not null;
create index idx_handoff_resolved_at     on public.handoff_events (resolved_at) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_contacts_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create trigger trg_leads_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

create trigger trg_conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create trigger trg_appointment_requests_updated_at
  before update on public.appointment_requests
  for each row execute function public.set_updated_at();

create trigger trg_handoff_events_updated_at
  before update on public.handoff_events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- API route handlers use the service-role key and bypass RLS.
-- RLS policies below are designed for future direct-client / Realtime access.

alter table public.contacts           enable row level security;
alter table public.leads              enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.appointment_requests enable row level security;
alter table public.handoff_events     enable row level security;

-- Service role bypasses all RLS (used by Next.js route handlers).
-- The policies below govern authenticated staff users (Supabase Auth).

-- Staff can read everything
create policy "staff_read_all" on public.contacts
  for select to authenticated using (true);
create policy "staff_read_all" on public.leads
  for select to authenticated using (true);
create policy "staff_read_all" on public.conversations
  for select to authenticated using (true);
create policy "staff_read_all" on public.messages
  for select to authenticated using (true);
create policy "staff_read_all" on public.appointment_requests
  for select to authenticated using (true);
create policy "staff_read_all" on public.handoff_events
  for select to authenticated using (true);

-- Staff can insert/update leads, appointment_requests, handoff_events
create policy "staff_write_leads" on public.leads
  for all to authenticated using (true) with check (true);
create policy "staff_write_appointment_requests" on public.appointment_requests
  for all to authenticated using (true) with check (true);
create policy "staff_write_handoff_events" on public.handoff_events
  for all to authenticated using (true) with check (true);
