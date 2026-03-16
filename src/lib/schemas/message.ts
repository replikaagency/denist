import { z } from 'zod/v4';

// Inbound patient message (from the chat widget)
export const InboundMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z.string().trim().min(1, 'Message cannot be empty').max(4000),
  // session_token re-authenticates the sender on each request (stateless)
  session_token: z.string().min(1).max(200),
});

export type InboundMessageInput = z.infer<typeof InboundMessageSchema>;
