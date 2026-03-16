import { z } from 'zod/v4';

export const AppointmentTypeSchema = z.enum([
  'new_patient',
  'checkup',
  'emergency',
  'whitening',
  'implant_consult',
  'orthodontic_consult',
  'other',
]);

const AppointmentRequestStatusSchema = z.enum([
  'pending',
  'confirmed',
  'cancelled',
  'no_show',
  'completed',
]);

const TimeOfDaySchema = z.enum(['morning', 'afternoon', 'evening', 'any']);

const DayOfWeekSchema = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

// Used by AI tool output + direct API calls
export const AppointmentRequestCreateSchema = z.object({
  contact_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  appointment_type: AppointmentTypeSchema,
  preferred_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .optional(),
  preferred_time_of_day: TimeOfDaySchema.optional(),
  preferred_days: z.array(DayOfWeekSchema).optional().default([]),
  notes: z.string().trim().max(2000).optional(),
});

// Staff update
export const AppointmentRequestUpdateSchema = z.object({
  status: AppointmentRequestStatusSchema.optional(),
  confirmed_datetime: z.iso.datetime().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const AppointmentListQuerySchema = z.object({
  status: AppointmentRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type AppointmentRequestCreateInput = z.infer<typeof AppointmentRequestCreateSchema>;
export type AppointmentRequestUpdateInput = z.infer<typeof AppointmentRequestUpdateSchema>;
export type AppointmentListQuery = z.infer<typeof AppointmentListQuerySchema>;
