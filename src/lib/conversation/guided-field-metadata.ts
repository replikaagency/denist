/**
 * Message metadata for guided UI chips (patient status, time preference, etc.).
 */
export function buildGuidedFieldMetadata(field: string): Record<string, unknown> {
  if (field === 'patient.new_or_returning') {
    return {
      type: 'patient_status_choice',
      field: 'new_or_returning',
      options: [
        { label: 'Es mi primera vez', value: 'patient_status_new' },
        { label: 'Ya he venido antes', value: 'patient_status_returning' },
      ],
    };
  }
  if (field === 'appointment.preferred_time') {
    return {
      type: 'time_preference_choice',
      field: 'preferred_time',
      options: [
        { label: 'Mañana', value: 'time_morning' },
        { label: 'Tarde', value: 'time_afternoon' },
        { label: 'Hora concreta', value: 'time_exact' },
      ],
    };
  }
  return { type: 'quick_booking_entry', field };
}
