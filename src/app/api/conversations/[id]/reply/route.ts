// =============================================================================
// POST /api/conversations/[id]/reply — Staff sends a message to the patient
// =============================================================================

import { type NextRequest } from 'next/server';
import { z } from 'zod/v4';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { getConversationById, updateConversation, touchConversation } from '@/lib/db/conversations';
import { insertMessage } from '@/lib/db/messages';
import { getOpenHandoffForConversation, assignHandoffEvent } from '@/lib/db/handoffs';

const ReplySchema = z.object({
  content: z.string().min(1).max(4000),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    const body = await request.json();
    const parsed = ReplySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const conversation = await getConversationById(id);

    // Only allow replies to conversations that are waiting for or actively handled by staff
    if (conversation.status !== 'waiting_human' && conversation.status !== 'human_active') {
      return errorResponse(
        'CONFLICT',
        'Can only reply to conversations in waiting_human or human_active status.',
        409,
      );
    }

    // If this is the first staff reply, claim the conversation:
    // transition to human_active, disable AI, insert a join notification, and
    // assign the open handoff — mirroring the explicit takeover flow.
    let systemMessage = null;
    if (conversation.status === 'waiting_human') {
      await updateConversation(id, { status: 'human_active', ai_enabled: false });

      systemMessage = await insertMessage({
        conversation_id: id,
        role: 'system',
        content: 'A staff member has joined the conversation.',
        metadata: {
          type: 'takeover',
          staff_user_id: auth.user.id,
          staff_email: auth.user.email,
        },
      });

      const openHandoff = await getOpenHandoffForConversation(id);
      if (openHandoff) await assignHandoffEvent(openHandoff.id, auth.user.id);
    }

    // Persist the staff message
    const message = await insertMessage({
      conversation_id: id,
      role: 'human',
      content: parsed.data.content,
      metadata: {
        staff_user_id: auth.user.id,
        staff_email: auth.user.email,
      },
    });

    await touchConversation(id);

    return successResponse({ message, systemMessage }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
