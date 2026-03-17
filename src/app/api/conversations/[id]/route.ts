// =============================================================================
// GET  /api/conversations/[id]  — fetch a conversation (staff use)
// PATCH /api/conversations/[id] — update status / ai_enabled (staff use)
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { ConversationUpdateSchema } from '@/lib/schemas/conversation';
import { getConversationById, updateConversation } from '@/lib/db/conversations';
import { getAllMessages, insertMessage } from '@/lib/db/messages';
import { getOpenHandoffForConversation, resolveHandoffEvent } from '@/lib/db/handoffs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;
    const conversation = await getConversationById(id);
    const messages = await getAllMessages(id);
    return successResponse({ conversation, messages });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    const body = await request.json();
    const parsed = ConversationUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    // When closing a conversation, ensure AI is disabled and close any open handoff
    const closingStatuses = new Set(['resolved', 'abandoned']);
    const patch = parsed.data.status && closingStatuses.has(parsed.data.status)
      ? { ...parsed.data, ai_enabled: false }
      : parsed.data;

    const conversation = await updateConversation(id, patch);

    let systemMessage = null;
    if (parsed.data.status === 'resolved' || parsed.data.status === 'abandoned') {
      const openHandoff = await getOpenHandoffForConversation(id);
      if (openHandoff) await resolveHandoffEvent(openHandoff.id);

      const content = parsed.data.status === 'resolved'
        ? 'This conversation has been resolved.'
        : 'This conversation has been marked as abandoned.';

      systemMessage = await insertMessage({
        conversation_id: id,
        role: 'system',
        content,
        metadata: {
          type: parsed.data.status,
          staff_user_id: auth.user.id,
          staff_email: auth.user.email,
        },
      });
    }

    return successResponse({ conversation, systemMessage });
  } catch (err) {
    return handleRouteError(err);
  }
}
