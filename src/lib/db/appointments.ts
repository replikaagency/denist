import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type {
  AppointmentRequest,
  AppointmentType,
  AppointmentRequestStatus,
  AppointmentRequestWithContact,
} from '@/types/database';

// Re-export AppError so appointment.service.ts can surface typed errors.
export { AppError };

const db = () => createSupabaseAdminClient();

export async function createAppointmentRequest(insert: {
  contact_id: string;
  conversation_id?: string | null;
  lead_id?: string | null;
  appointment_type: AppointmentType;
  preferred_date?: string | null;
  preferred_time_of_day?: string | null;
  preferred_days?: string[];
  notes?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AppointmentRequest> {
  const { data, error } = await db()
    .from('appointment_requests')
    .insert({
      status: 'pending',
      preferred_days: [],
      metadata: {},
      ...insert,
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create appointment request', error);
  return data as AppointmentRequest;
}

/**
 * Return the most recent non-cancelled appointment request for a conversation,
 * or null if none exists. Used to prevent duplicate requests per conversation.
 */
export async function getOpenAppointmentRequestForConversation(
  conversationId: string,
): Promise<AppointmentRequest | null> {
  const { data, error } = await db()
    .from('appointment_requests')
    .select('*')
    .eq('conversation_id', conversationId)
    .in('status', ['pending', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw AppError.database('Failed to check appointment request', error);
  return data as AppointmentRequest | null;
}

export async function getAppointmentRequestById(id: string): Promise<AppointmentRequest> {
  const { data, error } = await db()
    .from('appointment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch appointment request', error);
  if (!data) throw AppError.notFound('AppointmentRequest', id);
  return data as AppointmentRequest;
}

/**
 * Enrich an existing appointment request with more-complete field values.
 * Only accepts scheduling fields (not status) so callers cannot accidentally
 * change request lifecycle via this path.
 */
export async function enrichAppointmentRequest(
  id: string,
  patch: Partial<Pick<AppointmentRequest, 'appointment_type' | 'preferred_date' | 'preferred_time_of_day' | 'notes'>>,
): Promise<AppointmentRequest> {
  const { data, error } = await db()
    .from('appointment_requests')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to enrich appointment request', error);
  if (!data) throw AppError.notFound('AppointmentRequest', id);
  return data as AppointmentRequest;
}

export async function updateAppointmentRequest(
  id: string,
  patch: Partial<Pick<AppointmentRequest, 'status' | 'confirmed_datetime' | 'notes'>>,
): Promise<AppointmentRequest> {
  const confirmedAt =
    patch.status === 'confirmed' ? new Date().toISOString() : undefined;

  const { data, error } = await db()
    .from('appointment_requests')
    .update({ ...patch, ...(confirmedAt ? { confirmed_at: confirmedAt } : {}) })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update appointment request', error);
  if (!data) throw AppError.notFound('AppointmentRequest', id);
  return data as AppointmentRequest;
}

/**
 * Return all open (pending | confirmed) appointment requests for a contact,
 * across ALL conversations. Used by the reschedule flow to find which
 * appointment(s) the patient might want to change.
 */
export async function getOpenAppointmentRequestsForContact(
  contactId: string,
): Promise<AppointmentRequest[]> {
  const { data, error } = await db()
    .from('appointment_requests')
    .select('*')
    .eq('contact_id', contactId)
    .in('status', ['pending', 'confirmed'])
    .order('created_at', { ascending: false });

  if (error) throw AppError.database('Failed to fetch open requests for contact', error);
  return (data ?? []) as AppointmentRequest[];
}

/**
 * Call the reschedule_appointment_request Postgres RPC.
 * Cancels the old request and creates the new one in a single transaction.
 * Returns the new request UUID.
 *
 * Throws typed AppErrors on known failure codes so callers can handle them
 * gracefully without parsing raw Postgres error text.
 */
export async function rescheduleAppointmentRequestRPC(params: {
  oldRequestId: string;
  contactId: string;
  conversationId: string;
  leadId: string;
  appointmentType: AppointmentType;
  preferredDate: string | null;
  preferredTimeOfDay: string | null;
  notes: string | null;
}): Promise<string> {
  // supabase-js RPC types are derived from Database['public']['Functions'].
  // The reschedule function was added via a migration and is not in the
  // generated type, so we cast to `any` for this one call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db() as any).rpc('reschedule_appointment_request', {
    p_old_request_id:  params.oldRequestId,
    p_contact_id:      params.contactId,
    p_conversation_id: params.conversationId,
    p_lead_id:         params.leadId,
    p_appointment_type: params.appointmentType,
    p_preferred_date:  params.preferredDate,
    p_preferred_time:  params.preferredTimeOfDay,
    p_notes:           params.notes,
  });

  if (error) {
    if (error.message?.includes('RESCHEDULE_NOT_FOUND')) {
      throw AppError.notFound('AppointmentRequest', params.oldRequestId);
    }
    if (error.message?.includes('RESCHEDULE_ALREADY_CLOSED')) {
      throw AppError.conflict('That appointment has already been cancelled or completed.');
    }
    throw AppError.database('Reschedule RPC failed', error);
  }

  return data as string;
}

export async function listAppointmentRequests(params: {
  status?: AppointmentRequestStatus;
  limit: number;
  offset: number;
}): Promise<{ requests: AppointmentRequestWithContact[]; total: number }> {
  let query = db()
    .from('appointment_requests')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.status) query = query.eq('status', params.status);

  const { data, error, count } = await query;

  if (error) throw AppError.database('Failed to list appointment requests', error);
  return {
    requests: (data ?? []) as AppointmentRequestWithContact[],
    total: count ?? 0,
  };
}
