// =============================================================================
// GET /api/conversations/[id]/messages
// Returns all messages for a conversation (used by the staff inbox / admin).
// Patients fetch messages via the chat widget state — not this endpoint.
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { getConversationById } from '@/lib/db/conversations';
import { getAllMessages } from '@/lib/db/messages';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;
    await getConversationById(id);
    const messages = await getAllMessages(id);
    return successResponse({ messages, count: messages.length });
  } catch (err) {
    return handleRouteError(err);
  }
}
