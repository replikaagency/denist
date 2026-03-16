import { createAppointmentRequest } from '@/lib/db/appointments';
import { advanceLeadStatus } from '@/lib/db/leads';
import { updateConversation } from '@/lib/db/conversations';
import type { AppointmentRequest, AppointmentType } from '@/types/database';
import type { AppointmentDetails } from '@/lib/conversation/schema';

const SERVICE_TYPE_TO_APPOINTMENT_TYPE: Record<string, AppointmentType> = {
  cleaning: 'checkup',
  checkup: 'checkup',
  'emergency exam': 'emergency',
  emergency: 'emergency',
  whitening: 'whitening',
  implant: 'implant_consult',
  'implant consult': 'implant_consult',
  orthodontic: 'orthodontic_consult',
  'orthodontic consult': 'orthodontic_consult',
};

function resolveAppointmentType(serviceType: string | null): AppointmentType {
  if (!serviceType) return 'other';
  const normalized = serviceType.toLowerCase().trim();
  return SERVICE_TYPE_TO_APPOINTMENT_TYPE[normalized] ?? 'other';
}

/**
 * Create an appointment request from engine output.
 * Advances the lead to `appointment_requested`.
 */
export async function createRequest(input: {
  contactId: string;
  conversationId: string;
  leadId: string;
  appointment: Partial<AppointmentDetails>;
}): Promise<AppointmentRequest> {
  const request = await createAppointmentRequest({
    contact_id: input.contactId,
    conversation_id: input.conversationId,
    lead_id: input.leadId,
    appointment_type: resolveAppointmentType(input.appointment.service_type ?? null),
    preferred_date: input.appointment.preferred_date ?? null,
    preferred_time_of_day: input.appointment.preferred_time ?? null,
    notes: input.appointment.preferred_provider
      ? `Preferred provider: ${input.appointment.preferred_provider}`
      : null,
  });

  await advanceLeadStatus(input.contactId, 'appointment_requested');
  await updateConversation(input.conversationId, { lead_id: input.leadId });

  return request;
}
