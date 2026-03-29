import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { cancelRealAppointment } from '@/services/real-booking.service';

const CancelAppointmentSchema = z.object({
  appointment_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CancelAppointmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    const result = await cancelRealAppointment(parsed.data);
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
}
