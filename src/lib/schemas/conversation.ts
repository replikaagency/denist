import { z } from 'zod/v4';

const ConversationChannelSchema = z.enum(['web_chat', 'sms', 'email', 'whatsapp']);
const ConversationStatusSchema = z.enum([
  'active',
  'waiting_human',
  'human_active',
  'resolved',
  'abandoned',
]);

export const ConversationCreateSchema = z.object({
  // session_token identifies the (possibly anonymous) contact
  session_token: z.string().min(1).max(200),
  channel: ConversationChannelSchema.optional().default('web_chat'),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export const ConversationUpdateSchema = z.object({
  status: ConversationStatusSchema.optional(),
  ai_enabled: z.boolean().optional(),
  summary: z.string().max(2000).optional(),
});

export type ConversationCreateInput = z.infer<typeof ConversationCreateSchema>;
export type ConversationUpdateInput = z.infer<typeof ConversationUpdateSchema>;
