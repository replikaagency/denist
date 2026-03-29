import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { log } from '@/lib/logger';

type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'rescheduled';

type AppointmentRow = {
  id: string;
  patient_name: string;
  phone: string;
  datetime_start: string;
  datetime_end: string;
  status: BookingStatus;
  created_at?: string;
};

export type BookingMutationResult = {
  success: boolean;
  appointment_id?: string;
  error?: string;
};

const db = () => createSupabaseAdminClient();

function isBusinessHoursWindow(startIso: string, endIso: string): boolean {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (end <= start) return false;

  const day = start.getUTCDay();
  if (day === 0 || day === 6) return false;

  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
  const open = 9 * 60;
  const close = 19 * 60;
  return startMinutes >= open && endMinutes <= close;
}

async function hasConflict(input: {
  datetime_start: string;
  datetime_end: string;
  excludeAppointmentId?: string;
}): Promise<boolean> {
  const { data, error } = await db()
    .from('appointments')
    .select('id, datetime_start, datetime_end, status')
    .in('status', ['pending', 'confirmed', 'rescheduled'])
    .neq('id', input.excludeAppointmentId ?? '00000000-0000-0000-0000-000000000000')
    .lt('datetime_start', input.datetime_end)
    .gt('datetime_end', input.datetime_start)
    .limit(1);

  if (error) {
    log('error', 'appointments.conflict_check_failed', { error: error.message });
    return true;
  }
  return (data ?? []).length > 0;
}

export async function createRealAppointment(input: {
  patient_name: string;
  phone: string;
  datetime_start: string;
  datetime_end: string;
}): Promise<BookingMutationResult> {
  const { patient_name, phone, datetime_start, datetime_end } = input;
  if (!patient_name?.trim() || !phone?.trim() || !datetime_start || !datetime_end) {
    return { success: false, error: 'Missing required fields' };
  }
  if (!isBusinessHoursWindow(datetime_start, datetime_end)) {
    return { success: false, error: 'Outside business hours' };
  }
  if (await hasConflict({ datetime_start, datetime_end })) {
    return { success: false, error: 'Time slot is not available' };
  }

  const { data, error } = await db()
    .from('appointments')
    .insert({
      patient_name: patient_name.trim(),
      phone: phone.trim(),
      datetime_start,
      datetime_end,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    return { success: false, error: 'Failed to create appointment' };
  }
  return { success: true, appointment_id: data.id as string };
}

export async function rescheduleRealAppointment(input: {
  appointment_id: string;
  datetime_start: string;
  datetime_end: string;
}): Promise<BookingMutationResult> {
  const { appointment_id, datetime_start, datetime_end } = input;
  if (!appointment_id || !datetime_start || !datetime_end) {
    return { success: false, error: 'Missing required fields' };
  }
  if (!isBusinessHoursWindow(datetime_start, datetime_end)) {
    return { success: false, error: 'Outside business hours' };
  }
  if (await hasConflict({ datetime_start, datetime_end, excludeAppointmentId: appointment_id })) {
    return { success: false, error: 'Time slot is not available' };
  }

  const { data, error } = await db()
    .from('appointments')
    .update({
      datetime_start,
      datetime_end,
      status: 'rescheduled',
    })
    .eq('id', appointment_id)
    .select('id')
    .maybeSingle();

  if (error || !data?.id) {
    return { success: false, error: 'Appointment not found or not updated' };
  }
  return { success: true, appointment_id: data.id as string };
}

export async function cancelRealAppointment(input: {
  appointment_id: string;
}): Promise<BookingMutationResult> {
  const { appointment_id } = input;
  if (!appointment_id) return { success: false, error: 'Missing required fields' };

  const { data, error } = await db()
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appointment_id)
    .select('id')
    .maybeSingle();

  if (error || !data?.id) {
    return { success: false, error: 'Appointment not found or not updated' };
  }
  return { success: true, appointment_id: data.id as string };
}

export async function findLatestActiveAppointmentByPhone(
  phone: string,
): Promise<AppointmentRow | null> {
  const normalized = phone?.trim();
  if (!normalized) return null;

  const { data, error } = await db()
    .from('appointments')
    .select('id, patient_name, phone, datetime_start, datetime_end, status, created_at')
    .eq('phone', normalized)
    .in('status', ['pending', 'confirmed', 'rescheduled'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return (data as AppointmentRow | null) ?? null;
}
