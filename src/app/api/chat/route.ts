import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { InboundMessageSchema } from '@/lib/schemas/message';
import { processChatMessage } from '@/services/chat.service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = InboundMessageSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const result = await processChatMessage(parsed.data);

    return successResponse({
      message: result.message,
      contact: result.contact,
      conversation: result.conversation,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
