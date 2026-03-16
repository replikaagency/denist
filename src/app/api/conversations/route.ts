// =============================================================================
// POST /api/conversations
// Called by the chat widget on load to create (or resume) a conversation.
//
// Flow:
//  - If session_token matches an existing contact with an active conversation,
//    return it (resume).
//  - Otherwise, create an anonymous contact + new conversation.
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { ConversationCreateSchema } from '@/lib/schemas/conversation';
import { findContactBySessionToken, createContact } from '@/lib/db/contacts';
import { createConversation } from '@/lib/db/conversations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Conversation } from '@/types/database';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = ConversationCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }
    const { session_token, channel, metadata } = parsed.data;

    // Try to find an existing contact with this session token
    let contact = await findContactBySessionToken(session_token);

    if (!contact) {
      // Create an anonymous contact — will be enriched by the AI during the conversation
      contact = await createContact({ session_token, metadata: {} });
    }

    // Check for an existing active conversation to resume
    const supabase = createSupabaseAdminClient();
    const { data: existingRaw } = await supabase
      .from('conversations')
      .select('*')
      .eq('contact_id', contact.id)
      .eq('status', 'active')
      .eq('channel', channel)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const existing = existingRaw as Conversation | null;

    const conversation: Conversation = existing ?? (await createConversation({
      contact_id: contact.id,
      channel,
      metadata,
    }));

    return successResponse({ conversation, contact }, existing ? 200 : 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
