// =============================================================================
// GET /api/conversations/[id]/debug — staff-only correction observability
// Returns derived correction metrics from ConversationState.metadata.
// Read-only. No DB writes. No booking logic.
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { loadState } from '@/services/conversation.service';
import { CORRECTION_ALERT_THRESHOLD } from '@/lib/conversation/engine';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    // loadState calls getConversationById internally — throws AppError (404)
    // if the conversation does not exist, which handleRouteError surfaces.
    const state = await loadState(id);

    const { correction_log, correction_count, last_correction_at, too_many_corrections } =
      state.metadata;

    return successResponse({
      conversation_id:     id,
      correction_count,
      last_correction_at,
      too_many_corrections,
      threshold:           CORRECTION_ALERT_THRESHOLD,
      correction_log,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
