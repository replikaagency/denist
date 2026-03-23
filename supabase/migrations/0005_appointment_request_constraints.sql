-- =============================================================================
-- Migration: 0005_appointment_request_constraints.sql
-- Purpose:   Enforce business rules on appointment_requests via CHECK constraints.
--            Uses NOT VALID so existing rows are not scanned at migration time.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CONSTRAINT 1: When status = 'confirmed', booking fields must be present.
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointment_requests
  ADD CONSTRAINT chk_appt_req_confirmed_fields
  CHECK (
    status <> 'confirmed'
    OR (
      confirmed_datetime IS NOT NULL
      AND confirmed_at IS NOT NULL
    )
  )
  NOT VALID;

-- ---------------------------------------------------------------------------
-- CONSTRAINT 2: When status = 'pending', scheduling intent fields must be present.
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointment_requests
  ADD CONSTRAINT chk_appt_req_pending_fields
  CHECK (
    status <> 'pending'
    OR (
      preferred_time_of_day IS NOT NULL
      AND (
        preferred_date IS NOT NULL
        OR array_length(preferred_days, 1) > 0
      )
    )
  )
  NOT VALID;

-- ---------------------------------------------------------------------------
-- VALIDATE (manual step — do NOT run this automatically)
-- ---------------------------------------------------------------------------
-- After cleaning any existing rows that violate the constraints above,
-- run these statements manually to promote each constraint to fully enforced:
--
--   ALTER TABLE public.appointment_requests
--     VALIDATE CONSTRAINT chk_appt_req_confirmed_fields;
--
--   ALTER TABLE public.appointment_requests
--     VALIDATE CONSTRAINT chk_appt_req_pending_fields;
--
-- To identify rows that would fail validation before running:
--
--   -- Rows that would violate chk_appt_req_confirmed_fields:
--   SELECT id, status, confirmed_datetime, confirmed_at
--   FROM public.appointment_requests
--   WHERE status = 'confirmed'
--     AND (confirmed_datetime IS NULL OR confirmed_at IS NULL);
--
--   -- Rows that would violate chk_appt_req_pending_fields:
--   SELECT id, status, preferred_date, preferred_time_of_day, preferred_days
--   FROM public.appointment_requests
--   WHERE status = 'pending'
--     AND (
--       preferred_time_of_day IS NULL
--       OR (preferred_date IS NULL AND array_length(preferred_days, 1) IS NULL)
--     );
-- ---------------------------------------------------------------------------
