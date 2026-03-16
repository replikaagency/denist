import { z } from 'zod/v4';

export const HandoffReasonSchema = z.enum([
  'patient_request',
  'ai_escalation',
  'complex_query',
  'complaint',
  'emergency',
  'other',
]);

export const HandoffCreateSchema = z.object({
  conversation_id: z.string().uuid(),
  reason: HandoffReasonSchema,
  trigger_message_id: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const HandoffResolveSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});

export type HandoffCreateInput = z.infer<typeof HandoffCreateSchema>;
export type HandoffResolveInput = z.infer<typeof HandoffResolveSchema>;
