import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type {
  AppointmentRequest,
  AppointmentType,
  AppointmentRequestStatus,
  AppointmentRequestWithContact,
} from '@/types/database';

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
