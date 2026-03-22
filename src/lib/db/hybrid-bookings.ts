import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { HybridBooking, HybridBookingMode, HybridBookingStatus } from '@/types/database';

const db = () => createSupabaseAdminClient();

export async function createHybridBooking(insert: {
  contact_id: string;
  conversation_id?: string | null;
  lead_id?: string | null;
  service_interest?: string | null;
  preferred_days?: string[];
  preferred_time_ranges?: string[];
  availability_notes?: string | null;
  wants_callback?: boolean;
  booking_mode: HybridBookingMode;
  status?: HybridBookingStatus;
  metadata?: Record<string, unknown>;
}): Promise<HybridBooking> {
  const { data, error } = await db()
    .from('hybrid_bookings')
    .insert({
      preferred_days: [],
      preferred_time_ranges: [],
      wants_callback: true,
      status: 'new',
      metadata: {},
      ...insert,
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create hybrid booking', error);
  return data as HybridBooking;
}

export async function getHybridBookingById(id: string): Promise<HybridBooking> {
  const { data, error } = await db()
    .from('hybrid_bookings')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch hybrid booking', error);
  if (!data) throw AppError.notFound('HybridBooking', id);
  return data as HybridBooking;
}

export async function getActiveHybridBookingForConversation(
  conversationId: string,
): Promise<HybridBooking | null> {
  const { data, error } = await db()
    .from('hybrid_bookings')
    .select('*')
    .eq('conversation_id', conversationId)
    .in('status', ['new', 'pending_slot', 'contacted'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch hybrid booking', error);
  return data as HybridBooking | null;
}

export async function updateHybridBooking(
  id: string,
  patch: Partial<
    Pick<
      HybridBooking,
      | 'service_interest'
      | 'preferred_days'
      | 'preferred_time_ranges'
      | 'availability_notes'
      | 'wants_callback'
      | 'booking_mode'
      | 'status'
      | 'lead_id'
      | 'metadata'
    >
  >,
): Promise<HybridBooking> {
  const { data, error } = await db()
    .from('hybrid_bookings')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update hybrid booking', error);
  if (!data) throw AppError.notFound('HybridBooking', id);
  return data as HybridBooking;
}
