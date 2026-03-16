// =============================================================================
// GET  /api/conversations/[id]  — fetch a conversation (staff use)
// PATCH /api/conversations/[id] — update status / ai_enabled (staff use)
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { ConversationUpdateSchema } from '@/lib/schemas/conversation';
import { getConversationById, updateConversation } from '@/lib/db/conversations';
import { getAllMessages } from '@/lib/db/messages';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
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
    const { id } = await params;

    const body = await request.json();
    const parsed = ConversationUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const conversation = await updateConversation(id, parsed.data);
    return successResponse({ conversation });
  } catch (err) {
    return handleRouteError(err);
  }
}
