import { z } from 'zod/v4';

const ConversationStatusSchema = z.enum([
  'active',
  'waiting_human',
  'human_active',
  'resolved',
  'abandoned',
]);

export const ConversationUpdateSchema = z.object({
  status: ConversationStatusSchema.optional(),
  ai_enabled: z.boolean().optional(),
  summary: z.string().max(2000).optional(),
});

export type ConversationUpdateInput = z.infer<typeof ConversationUpdateSchema>;
