import { expect, test } from 'vitest';
import {
  APPOINTMENT_REQUEST_RECEPTION_FIELD_ORDER,
  fieldQueryOptionsFromState,
  getMissingFields,
  getNextFieldPrompt,
} from './fields';
import type { Intent } from './taxonomy';

const APPOINTMENT_REQUEST: Intent = 'appointment_request';

const emptyPatient = {
  full_name: null as string | null,
  phone: null as string | null,
  email: null as string | null,
  date_of_birth: null as string | null,
  new_or_returning: null as 'new' | 'returning' | null,
  insurance_provider: null as string | null,
  insurance_member_id: null as string | null,
};

const emptyAppointment = {
  service_type: null as string | null,
  preferred_date: null as string | null,
  preferred_time: null as string | null,
  preferred_provider: null as string | null,
  flexibility: null as 'flexible' | 'somewhat_flexible' | 'fixed' | null,
};

const emptySymptoms = {};

test('reception appointment_request orders missing fields phone before name', () => {
  const filled = {
    patient: { ...emptyPatient },
    appointment: { ...emptyAppointment },
    symptoms: emptySymptoms,
  };
  const missing = getMissingFields(APPOINTMENT_REQUEST, filled, {
    receptionIntakePhoneFirst: true,
  });
  expect(missing[0]).toBe('patient.phone');
  expect(missing[1]).toBe('patient.full_name');
});

test('default appointment_request keeps name before phone', () => {
  const filled = {
    patient: { ...emptyPatient },
    appointment: { ...emptyAppointment },
    symptoms: emptySymptoms,
  };
  const missing = getMissingFields(APPOINTMENT_REQUEST, filled);
  expect(missing[0]).toBe('patient.full_name');
  expect(missing[1]).toBe('patient.phone');
});

test('fieldQueryOptionsFromState enables reception order only when flag set', () => {
  expect(
    fieldQueryOptionsFromState({
      current_intent: APPOINTMENT_REQUEST,
      metadata: { reception_intake_phone_first: true },
    }),
  ).toEqual({ receptionIntakePhoneFirst: true });
  expect(
    fieldQueryOptionsFromState({
      current_intent: APPOINTMENT_REQUEST,
      metadata: {},
    }),
  ).toEqual({});
});

test('getNextFieldPrompt reception asks phone first', () => {
  const filled = {
    patient: { ...emptyPatient },
    appointment: { ...emptyAppointment },
    symptoms: emptySymptoms,
  };
  const next = getNextFieldPrompt(APPOINTMENT_REQUEST, filled, {
    receptionIntakePhoneFirst: true,
  });
  expect(next?.field).toBe('patient.phone');
  expect(next?.prompt).toContain('número');
});

test('reception field order constant matches product spec', () => {
  expect(APPOINTMENT_REQUEST_RECEPTION_FIELD_ORDER).toEqual([
    'patient.phone',
    'patient.full_name',
    'patient.new_or_returning',
    'appointment.service_type',
    'appointment.preferred_date',
    'appointment.preferred_time',
  ]);
});
