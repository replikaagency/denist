import { z } from 'zod/v4';

export const HybridBookingStatusEnum = z.enum([
  'new',
  'pending_slot',
  'contacted',
  'booked',
  'closed',
]);

export const HybridBookingPatchSchema = z.object({
  status: HybridBookingStatusEnum,
});

export type HybridBookingPatchInput = z.infer<typeof HybridBookingPatchSchema>;
