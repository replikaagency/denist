import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { createRealAppointment } from '@/services/real-booking.service';

const CreateAppointmentSchema = z.object({
  patient_name: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  datetime_start: z.iso.datetime(),
  datetime_end: z.iso.datetime(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateAppointmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    const result = await createRealAppointment(parsed.data);
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
}
