// =============================================================================
// POST /api/conversations/[id]/takeover — Staff claims a conversation
// Transitions from waiting_human → human_active
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { getConversationById, updateConversation } from '@/lib/db/conversations';
import { insertMessage } from '@/lib/db/messages';
import { getOpenHandoffForConversation, assignHandoffEvent } from '@/lib/db/handoffs';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;
    const conversation = await getConversationById(id);

    if (conversation.status === 'resolved' || conversation.status === 'abandoned') {
      return errorResponse('CONFLICT', 'Cannot take over a closed conversation.', 409);
    }

    // Transition to human_active, ensure AI is off
    const updated = await updateConversation(id, {
      status: 'human_active',
      ai_enabled: false,
    });

    // Insert a system message so the patient sees a notification
    await insertMessage({
      conversation_id: id,
      role: 'system',
      content: 'A staff member has joined the conversation.',
      metadata: {
        type: 'takeover',
        staff_user_id: auth.user.id,
        staff_email: auth.user.email,
      },
    });

    // Assign the staff member to the open handoff event (if one exists)
    const openHandoff = await getOpenHandoffForConversation(id);
    if (openHandoff) await assignHandoffEvent(openHandoff.id, auth.user.id);

    return successResponse({ conversation: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}
