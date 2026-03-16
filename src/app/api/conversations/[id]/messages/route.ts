// =============================================================================
// GET /api/conversations/[id]/messages
// Returns all messages for a conversation (used by the staff inbox / admin).
// Patients fetch messages via the chat widget state — not this endpoint.
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, handleRouteError } from '@/lib/response';
import { getConversationById } from '@/lib/db/conversations';
import { getAllMessages } from '@/lib/db/messages';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    // Confirm conversation exists before fetching messages (gives 404 if not)
    await getConversationById(id);
    const messages = await getAllMessages(id);
    return successResponse({ messages, count: messages.length });
  } catch (err) {
    return handleRouteError(err);
  }
}
