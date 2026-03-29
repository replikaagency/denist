import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { rescheduleRealAppointment } from '@/services/real-booking.service';

const RescheduleAppointmentSchema = z.object({
  appointment_id: z.string().uuid(),
  datetime_start: z.iso.datetime(),
  datetime_end: z.iso.datetime(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = RescheduleAppointmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    const result = await rescheduleRealAppointment(parsed.data);
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
}
