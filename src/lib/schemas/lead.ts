import { z } from 'zod/v4';

const LeadStatusSchema = z.enum([
  'new',
  'contacted',
  'qualified',
  'appointment_requested',
  'booked',
  'lost',
  'disqualified',
]);

export const LeadUpdateSchema = z.object({
  status: LeadStatusSchema.optional(),
  source: z.string().trim().max(100).optional(),
  treatment_interest: z.array(z.string().trim().max(100)).optional(),
  notes: z.string().trim().max(5000).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

export const LeadListQuerySchema = z.object({
  status: LeadStatusSchema.optional(),
  assigned_to: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type LeadUpdateInput = z.infer<typeof LeadUpdateSchema>;
export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;
