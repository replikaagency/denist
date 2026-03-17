-- =============================================================================
-- Appointment Request Deduplication Constraint
-- =============================================================================
-- Prevents duplicate open (pending or confirmed) appointment requests for the
-- same conversation at the DB level.
--
-- The application layer already checks for an existing open request before
-- inserting (see lib/db/appointments.ts: getOpenAppointmentRequestForConversation),
-- but that is a check-then-act pattern with a theoretical race window.
-- This partial unique index is the authoritative backstop.
--
-- Partial index semantics:
--   - Only rows where conversation_id IS NOT NULL are indexed.
--   - Only rows where status is 'pending' or 'confirmed' are indexed.
--   - A cancelled request does NOT block a new request for the same conversation
--     (i.e., staff can cancel and the patient can re-request in the same session).
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_req_one_open_per_conv
  ON public.appointment_requests (conversation_id)
  WHERE status IN ('pending', 'confirmed')
    AND conversation_id IS NOT NULL;
