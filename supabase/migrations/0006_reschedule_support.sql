-- =============================================================================
-- Migration: 0006_reschedule_support.sql
-- Adds reschedule audit columns to appointment_requests and the atomic
-- reschedule RPC that cancels the old row and creates the new one in a
-- single Postgres transaction.
-- =============================================================================

-- Link a new request to the one it replaced.
ALTER TABLE public.appointment_requests
  ADD COLUMN IF NOT EXISTS rescheduled_from UUID
    REFERENCES public.appointment_requests(id) ON DELETE SET NULL;

-- Reverse pointer on the cancelled row for audit trail.
ALTER TABLE public.appointment_requests
  ADD COLUMN IF NOT EXISTS rescheduled_to UUID
    REFERENCES public.appointment_requests(id) ON DELETE SET NULL;

-- When was it cancelled (null = never cancelled).
ALTER TABLE public.appointment_requests
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Why was it cancelled.
ALTER TABLE public.appointment_requests
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- Find open requests for a contact across all conversations.
CREATE INDEX IF NOT EXISTS idx_appt_req_contact_open
  ON public.appointment_requests (contact_id, status)
  WHERE status IN ('pending', 'confirmed');

-- =============================================================================
-- Atomic reschedule RPC
-- =============================================================================
-- Cancels the old request and creates the new one in a single transaction.
-- Returns the new request's id. Raises exceptions on invalid state.
--
-- WHY an RPC instead of two app-level queries?
-- The dedup unique index blocks two open requests per conversation.
-- If we cancel app-side then insert, a concurrent request could slip in
-- between. The RPC uses FOR UPDATE and a single transaction, so the
-- cancel + insert is atomic and the unique index is never violated.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reschedule_appointment_request(
  p_old_request_id      UUID,
  p_contact_id          UUID,
  p_conversation_id     UUID,
  p_lead_id             UUID,
  p_appointment_type    public.appointment_type,
  p_preferred_date      DATE,
  p_preferred_time      TEXT,
  p_notes               TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_old RECORD;
  v_new_id UUID;
BEGIN
  -- Lock the old request row
  SELECT * INTO v_old
    FROM public.appointment_requests
    WHERE id = p_old_request_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESCHEDULE_NOT_FOUND: Old request % does not exist', p_old_request_id;
  END IF;

  IF v_old.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'RESCHEDULE_ALREADY_CLOSED: Old request % has status %', p_old_request_id, v_old.status;
  END IF;

  -- Cancel the old request
  UPDATE public.appointment_requests
  SET status       = 'cancelled',
      cancelled_at = NOW(),
      cancel_reason = 'rescheduled_by_patient'
  WHERE id = p_old_request_id;

  -- Create the new request
  INSERT INTO public.appointment_requests (
    contact_id, conversation_id, lead_id,
    appointment_type, status,
    preferred_date, preferred_time_of_day, notes,
    rescheduled_from, metadata
  ) VALUES (
    p_contact_id, p_conversation_id, p_lead_id,
    p_appointment_type, 'pending',
    p_preferred_date, p_preferred_time, p_notes,
    p_old_request_id, '{}'::jsonb
  )
  RETURNING id INTO v_new_id;

  -- Back-link old → new
  UPDATE public.appointment_requests
  SET rescheduled_to = v_new_id
  WHERE id = p_old_request_id;

  RETURN v_new_id;
END;
$$;
