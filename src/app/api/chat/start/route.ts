import { type NextRequest } from 'next/server';
import { z } from 'zod/v4';
import { successResponse, handleRouteError, errorResponse } from '@/lib/response';
import { resolveContact } from '@/services/contact.service';
import { startOrResumeConversation } from '@/services/conversation.service';
import { insertMessage } from '@/lib/db/messages';
import { getRecentMessages } from '@/lib/db/messages';
import { AI_GREETING } from '@/config/constants';

const StartChatSchema = z.object({
  session_token: z.string().min(1).max(200),
});

/**
 * POST /api/chat/start
 *
 * Creates or resumes a conversation for the given session token.
 * If new, sends the AI greeting as the first message.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = StartChatSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const contact = await resolveContact(parsed.data.session_token);
    const { conversation, isNew } = await startOrResumeConversation(contact.id);

    let greeting = null;

    if (isNew) {
      greeting = await insertMessage({
        conversation_id: conversation.id,
        role: 'ai',
        content: AI_GREETING,
        metadata: { type: 'greeting' },
      });
    } else {
      const existingMessages = await getRecentMessages(conversation.id, 1);
      if (existingMessages.length === 0) {
        greeting = await insertMessage({
          conversation_id: conversation.id,
          role: 'ai',
          content: AI_GREETING,
          metadata: { type: 'greeting' },
        });
      }
    }

    return successResponse({
      conversation,
      contact,
      greeting,
    }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
