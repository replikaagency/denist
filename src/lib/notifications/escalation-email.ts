import { Resend } from 'resend';

export interface EscalationEmailData {
  conversationId: string;
  patientName: string | null;
  patientPhone: string | null;
  reason: string | null;
  escalationType: 'emergency' | 'urgent' | 'human' | null;
}

/**
 * Send an email notification when an AI-triggered escalation creates a handoff.
 * Fails silently if RESEND_API_KEY, ESCALATION_EMAIL_TO, or ESCALATION_EMAIL_FROM
 * are not configured — the handoff is always persisted regardless.
 */
export async function sendEscalationEmail(data: EscalationEmailData): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Notifications] RESEND_API_KEY not configured — skipping escalation email');
    return;
  }

  const to = process.env.ESCALATION_EMAIL_TO;
  const from = process.env.ESCALATION_EMAIL_FROM;
  if (!to || !from) {
    console.warn('[Notifications] ESCALATION_EMAIL_TO or ESCALATION_EMAIL_FROM not configured — skipping escalation email');
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const conversationUrl = `${appUrl}/dashboard/conversations/${data.conversationId}`;

  const patientDisplay = data.patientName ?? 'Paciente desconocido';
  const phoneDisplay = data.patientPhone ?? 'No disponible';
  const reasonDisplay = data.reason ?? 'Sin motivo especificado';
  const typeLabel =
    data.escalationType === 'emergency' ? 'URGENCIA' :
    data.escalationType === 'urgent'    ? 'URGENTE'  :
    'Requiere atención humana';
  const subject = `[${typeLabel}] Nueva escalación — ${patientDisplay}`;

  const body = [
    'Se ha creado una nueva escalación en el chat de recepción.',
    '',
    `Paciente:  ${patientDisplay}`,
    `Teléfono:  ${phoneDisplay}`,
    `Tipo:      ${typeLabel}`,
    `Motivo:    ${reasonDisplay}`,
    '',
    `Ver conversación: ${conversationUrl}`,
  ].join('\n');

  const resend = new Resend(apiKey);
  await resend.emails.send({ from, to, subject, text: body });
}
