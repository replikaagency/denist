import { z } from 'zod/v4';
import { LIMITS } from '@/config/constants';
import { SessionTokenSchema } from '@/lib/schemas/session';

// Inbound patient message (from the chat widget)
export const InboundMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(LIMITS.MAX_MESSAGE_LENGTH, `Message must be at most ${LIMITS.MAX_MESSAGE_LENGTH} characters`),
  // session_token re-authenticates the sender on each request (stateless)
  session_token: SessionTokenSchema,
});

export type InboundMessageInput = z.infer<typeof InboundMessageSchema>;
