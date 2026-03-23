import { describe, expect, it } from 'vitest';
import { normalizeTwilioWhatsAppInbound, TWILIO_FORM } from './twilio-webhook';

describe('normalizeTwilioWhatsAppInbound', () => {
  it('maps Twilio form fields to normalized inbound shape', () => {
    const form = new URLSearchParams();
    form.set(TWILIO_FORM.FROM, 'whatsapp:+34123456789');
    form.set(TWILIO_FORM.BODY, 'Hola');
    form.set(TWILIO_FORM.MESSAGE_SID, 'SM123');

    const n = normalizeTwilioWhatsAppInbound(form);
    expect(n).toEqual({
      channel: 'whatsapp',
      fromPhone: '+34123456789',
      body: 'Hola',
      externalMessageId: 'SM123',
      provider: 'twilio_whatsapp',
    });
  });

  it('returns null when body or from missing', () => {
    expect(normalizeTwilioWhatsAppInbound(new URLSearchParams())).toBeNull();
  });
});
