import { type NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import {
  twilioCoreEnvPresent,
  twilioWhatsAppInboundProcessingEnabled,
} from '@/lib/twilio/config';

/**
 * Twilio hits webhooks with POST (application/x-www-form-urlencoded).
 * This route is a safe stub: it never calls Twilio, never calls processChatMessage,
 * and always returns 200 + empty TwiML so Twilio does not retry storms.
 *
 * @see docs/whatsapp-twilio-plan.md
 */
function emptyTwiML(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

export async function GET() {
  return new NextResponse(
    'Twilio WhatsApp webhook (stub — inbound processing disabled). See docs/whatsapp-twilio-plan.md',
    { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}

export async function POST(_request: NextRequest) {
  const configured = twilioCoreEnvPresent();
  const wouldProcess = twilioWhatsAppInboundProcessingEnabled();

  log('info', 'twilio.whatsapp.webhook_stub_hit', {
    configured,
    inbound_enabled_flag: wouldProcess,
  });

  // TODO (activation): parse request.formData(), validate signature, normalizeTwilioWhatsAppInbound,
  // resolveContact({ channel: 'whatsapp', phone }), get/create conversation channel whatsapp,
  // derive session_token strategy (see docs), call processChatMessage.

  if (wouldProcess && configured) {
    log('warn', 'twilio.whatsapp.webhook_processing_not_implemented', {
      message:
        'TWILIO_WHATSAPP_INBOUND_ENABLED=true but handler is still stub — flip flag to false until wired',
    });
  }

  if (!configured) {
    log('warn', 'twilio.whatsapp.webhook_no_core_config', {});
  }

  return emptyTwiML();
}
