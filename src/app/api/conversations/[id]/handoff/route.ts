// =============================================================================
// POST /api/conversations/[id]/handoff
// Manually trigger a human handoff (e.g. patient clicks "Talk to a person").
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { HandoffCreateSchema } from '@/lib/schemas/handoff';
import { getConversationById, updateConversation } from '@/lib/db/conversations';
import { createHandoffEvent, getOpenHandoffForConversation } from '@/lib/db/handoffs';
import type { HandoffReason } from '@/types/database';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    const body = await request.json();
    const parsed = HandoffCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const conversation = await getConversationById(id);

    // Idempotency: do not create a second open handoff for the same conversation
    const openHandoff = await getOpenHandoffForConversation(id);
    if (openHandoff) {
      return successResponse({ handoff: openHandoff, conversation }, 200);
    }

    if (conversation.status === 'resolved' || conversation.status === 'abandoned') {
      return errorResponse('CONFLICT', 'Cannot handoff a closed conversation.', 409);
    }

    const handoff = await createHandoffEvent({
      conversation_id: id,
      contact_id: conversation.contact_id,
      reason: parsed.data.reason as HandoffReason,
      trigger_message_id: parsed.data.trigger_message_id,
      notes: parsed.data.notes,
    });

    const updated = await updateConversation(id, {
      status: 'waiting_human',
      ai_enabled: false,
    });

    return successResponse({ handoff, conversation: updated }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
