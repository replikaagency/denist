import { z } from 'zod/v4';

export const ContactCreateSchema = z.object({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(254).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s\-().]{7,20}$/, 'Invalid phone number format')
    .optional(),
  is_new_patient: z.boolean().optional().default(true),
  insurance_provider: z.string().trim().max(200).optional(),
  session_token: z.string().uuid().optional(),
});

export const ContactUpdateSchema = ContactCreateSchema.partial();

export type ContactCreateInput = z.infer<typeof ContactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateSchema>;
