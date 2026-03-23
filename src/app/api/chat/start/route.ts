import { type NextRequest } from 'next/server';
import { z } from 'zod/v4';
import { successResponse, handleRouteError, errorResponse } from '@/lib/response';
import { resolveContact } from '@/services/contact.service';
import { startOrResumeConversation } from '@/services/conversation.service';
import { insertMessage, getRecentMessages } from '@/lib/db/messages';
import { getAIGreeting, LIMITS } from '@/config/constants';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { SessionTokenSchema } from '@/lib/schemas/session';

const StartChatSchema = z.object({
  session_token: SessionTokenSchema,
});

/**
 * POST /api/chat/start
 *
 * Creates or resumes a conversation for the given session token.
 * Always returns `messages` — the full recent history — so the patient
 * chat widget can restore state without calling the staff-protected
 * messages endpoint.
 *
 * Status codes:
 *   201 — new conversation created
 *   200 — existing conversation resumed
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = StartChatSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    // Two-tier rate limiting: loose IP cap + tight per-token cap
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit(`chat-start-ip:${ip}`, 30, 60_000);
    if (!ipLimit.allowed) {
      return errorResponse('RATE_LIMITED', 'Demasiadas solicitudes desde esta dirección. Por favor, espera un momento.', 429);
    }
    const tokenLimit = checkRateLimit(`chat-start:${parsed.data.session_token}`, 10, 60_000);
    if (!tokenLimit.allowed) {
      return errorResponse('RATE_LIMITED', 'Demasiadas solicitudes. Por favor, espera un momento.', 429);
    }

    const contact = await resolveContact({ channel: 'web_chat', session_token: parsed.data.session_token });
    const { conversation, isNew } = await startOrResumeConversation(contact.id);

    let messages: Awaited<ReturnType<typeof getRecentMessages>>;

    if (isNew) {
      const greeting = await insertMessage({
        conversation_id: conversation.id,
        role: 'ai',
        content: getAIGreeting(),
        metadata: { type: 'greeting' },
      });
      messages = [greeting];
    } else {
      messages = await getRecentMessages(conversation.id, LIMITS.CONTEXT_WINDOW);

      // Defensive: active conversation exists but somehow has no messages.
      if (messages.length === 0) {
        const greeting = await insertMessage({
          conversation_id: conversation.id,
          role: 'ai',
          content: getAIGreeting(),
          metadata: { type: 'greeting' },
        });
        messages = [greeting];
      }
    }

    return successResponse({ conversation, contact, messages }, isNew ? 201 : 200);
  } catch (err) {
    return handleRouteError(err);
  }
}
