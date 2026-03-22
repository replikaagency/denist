-- Hybrid booking intake: parallel to appointment_requests for link offers + structured availability.

CREATE TYPE public.hybrid_booking_mode AS ENUM (
  'direct_link',
  'callback_request',
  'availability_capture'
);

CREATE TYPE public.hybrid_booking_status AS ENUM (
  'new',
  'pending_slot',
  'contacted',
  'booked',
  'closed'
);

CREATE TABLE public.hybrid_bookings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  conversation_id      uuid REFERENCES public.conversations (id) ON DELETE SET NULL,
  lead_id              uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  service_interest     text,
  preferred_days       text[] NOT NULL DEFAULT '{}',
  preferred_time_ranges text[] NOT NULL DEFAULT '{}',
  availability_notes   text,
  wants_callback       boolean NOT NULL DEFAULT true,
  booking_mode         public.hybrid_booking_mode NOT NULL,
  status               public.hybrid_booking_status NOT NULL DEFAULT 'new',
  metadata             jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hybrid_bookings IS
  'Hybrid intake: direct booking link path, callback request, or structured availability without a full appointment_requests row.';

CREATE INDEX idx_hybrid_bookings_contact_id ON public.hybrid_bookings (contact_id);
CREATE INDEX idx_hybrid_bookings_conv_id ON public.hybrid_bookings (conversation_id);
CREATE INDEX idx_hybrid_bookings_status ON public.hybrid_bookings (status);
CREATE INDEX idx_hybrid_bookings_created_at ON public.hybrid_bookings (created_at DESC);

CREATE TRIGGER trg_hybrid_bookings_updated_at
  BEFORE UPDATE ON public.hybrid_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.hybrid_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_read_hybrid_bookings"
  ON public.hybrid_bookings FOR SELECT TO authenticated USING (true);

CREATE POLICY "staff_write_hybrid_bookings"
  ON public.hybrid_bookings FOR ALL TO authenticated USING (true) WITH CHECK (true);
