import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { InboundMessageSchema } from '@/lib/schemas/message';
import { processChatMessage } from '@/services/chat.service';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { LIMITS } from '@/config/constants';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = InboundMessageSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    // Rate limit by IP (broad) and by session token (per-user)
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit(`chat-ip:${ip}`, LIMITS.MAX_MESSAGES_PER_MINUTE * 5, 60_000);
    if (!ipLimit.allowed) {
      return errorResponse('RATE_LIMITED', 'Demasiadas solicitudes desde esta dirección. Por favor, espera un momento.', 429);
    }
    const rateLimitKey = `chat:${parsed.data.session_token}`;
    const limit = checkRateLimit(rateLimitKey, LIMITS.MAX_MESSAGES_PER_MINUTE, 60_000);
    if (!limit.allowed) {
      return errorResponse(
        'RATE_LIMITED',
        'Demasiados mensajes seguidos. Por favor, espera un momento antes de enviar otro.',
        429,
      );
    }

    const result = await processChatMessage(parsed.data);

    return successResponse({
      message: result.message,
      contact: result.contact,
      conversation: result.conversation,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
