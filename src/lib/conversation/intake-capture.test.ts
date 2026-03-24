import { beforeEach, expect, test, vi } from 'vitest';
import type { Contact } from '@/types/database';
import { EARLIEST_AVAILABLE_PREFERRED_DATE } from './intake-guards';
import { tryDeterministicIntakeCapture } from './intake-capture';

const { resolvePhoneMock } = vi.hoisted(() => ({
  resolvePhoneMock: vi.fn(
    async (_patient: unknown, _cid: string, c: Contact): Promise<Contact> => c,
  ),
}));

vi.mock('@/services/contact.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/contact.service')>();
  return { ...actual, resolvePatientIdentityAfterPhoneCapture: resolvePhoneMock };
});

vi.mock('@/services/conversation.service', () => ({
  saveState: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/messages', () => ({
  insertMessage: vi.fn(async () => ({ id: 'm1' })),
}));

beforeEach(async () => {
  const { insertMessage } = await import('@/lib/db/messages');
  vi.mocked(insertMessage).mockClear();
  resolvePhoneMock.mockImplementation(async (_p, _cid, c) => c);
});

const baseState = (intent = 'appointment_request') => ({
  current_intent: intent,
  patient: { full_name: null, phone: null, email: null, new_or_returning: null },
  appointment: {},
  symptoms: {},
  metadata: {} as Record<string, unknown>,
});

test('captura nombre válido', async () => {
  const state = baseState();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'Juan Pérez',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.full_name).toBe('Juan Pérez');
});

test('captura teléfono válido', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: '678123456',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.phone).toBe('+34678123456');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?'),
    }),
  );
});

test('captura email válido', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  state.patient.new_or_returning = 'new';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'juan@gmail.com',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).toBeNull();
  expect(state.patient.email).toBeNull();
});

test('captura new_or_returning con sí', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  state.patient.email = 'juan@gmail.com';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'sí',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.new_or_returning).toBe('new');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('¿Para qué tipo de tratamiento quieres la cita? ¿Una limpieza, revisión, o algo distinto?'),
      metadata: expect.objectContaining({ field: 'new_or_returning' }),
    }),
  );
});

test('captura new_or_returning con no', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  state.patient.email = 'juan@gmail.com';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'no',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.new_or_returning).toBe('returning');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('¿Para qué tipo de tratamiento quieres la cita? ¿Una limpieza, revisión, o algo distinto?'),
      metadata: expect.objectContaining({ field: 'new_or_returning' }),
    }),
  );
});

test('no clasifica new_or_returning con ack "vale"; re-pregunta elección', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'vale',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.new_or_returning).toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({ type: 'patient_status_choice', field: 'new_or_returning' }),
    }),
  );
});

test('captura preferred_time con botón mañana', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  state.patient.new_or_returning = 'new';
  state.appointment.service_type = 'limpieza';
  state.appointment.preferred_date = 'martes';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'time_morning',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.appointment.preferred_time).toBe('morning');
});

test('captura preferred_time manual con "a las X"', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  state.patient.new_or_returning = 'new';
  state.appointment.service_type = 'limpieza';
  state.appointment.preferred_date = 'martes';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'a las 18:00',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.appointment.preferred_time).toBe('a las 18:00');
});

test('no captura si input inválido', async () => {
  const state = baseState();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'no entiendo',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).toBeNull();
});

test('si falta nombre y paciente responde "no", explica requisito sin repetir pregunta ciega', async () => {
  const state = baseState();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'no',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.full_name).toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('Para registrar la solicitud necesito ese dato'),
      metadata: expect.objectContaining({ type: 'intake_required_refusal', field: 'patient.full_name' }),
    }),
  );
});

test('si vuelve a rechazar nombre requerido, ofrece salida segura', async () => {
  const state = baseState();
  state.metadata.required_refusal_full_name_count = 1;
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'prefiero no decirlo',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('puedes escribir "cancelar"'),
      metadata: expect.objectContaining({ type: 'intake_required_refusal', field: 'patient.full_name' }),
    }),
  );
});

test('si falta telefono y paciente responde "mejor no", explica requisito de contacto', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'mejor no',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.phone).toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('Para registrar la solicitud necesito ese dato'),
      metadata: expect.objectContaining({ type: 'intake_required_refusal', field: 'patient.phone' }),
    }),
  );
});

test('booking shortcut captura varios datos y avanza al siguiente faltante', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '+34678123456';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'quiero una limpieza mañana por la tarde',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.appointment.service_type).toBe('limpieza');
  expect(state.appointment.preferred_date).toBe('mañana');
  expect(state.appointment.preferred_time).toBe('afternoon');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?'),
    }),
  );
});

test('booking shortcut captura nombre+telefono+servicio y responde duda breve', async () => {
  const state = baseState();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'soy Oliver Garcia, 666666666, limpieza mañana por la tarde, ¿cuánto cuesta?',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.full_name).toBe('Oliver Garcia');
  expect(state.patient.phone).toBe('+34666666666');
  expect(state.appointment.service_type).toBe('limpieza');
  expect(state.appointment.preferred_date).toBe('mañana');
  expect(state.appointment.preferred_time).toBe('afternoon');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('Sobre el precio, te lo confirma recepción según valoración.'),
    }),
  );
});

test('recepción: no captura nombre si el primer faltante es teléfono', async () => {
  const state = baseState();
  state.metadata.reception_intake_phone_first = true;
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'Juan Pérez',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).toBeNull();
  expect(state.patient.full_name).toBeNull();
});

test('recepción: tras teléfono hidrata nombre y no repregunta el nombre (sigue con estado de paciente)', async () => {
  resolvePhoneMock.mockImplementationOnce(async (patient) => {
    (patient as { full_name: string | null }).full_name = 'Ana García';
    return { id: 'c1' } as Contact;
  });
  const state = baseState();
  state.metadata.reception_intake_phone_first = true;
  const result = await tryDeterministicIntakeCapture({
    state,
    content: '600111222',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.full_name).toBe('Ana García');
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringMatching(/primera vez|paciente nuestro/i),
    }),
  );
  expect(vi.mocked(insertMessage).mock.calls[0][0].content).not.toMatch(/nombre completo/i);
});

test('recepción: si el estado de paciente ya está contestado, tras teléfono no lo repregunta', async () => {
  const state = baseState();
  state.metadata.reception_intake_phone_first = true;
  state.patient.new_or_returning = 'returning';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: '600111222',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  const payload = vi.mocked(insertMessage).mock.calls[0][0];
  expect(payload.content).not.toMatch(/primera vez|paciente nuestro/i);
  expect(payload.content).toMatch(/nombre completo/i);
});

test('recepción: lookup completa nombre y estado; siguiente pregunta es servicio', async () => {
  resolvePhoneMock.mockImplementationOnce(async (patient) => {
    const p = patient as {
      full_name: string | null;
      new_or_returning: 'new' | 'returning' | null;
    };
    p.full_name = 'Pedro Ruiz';
    p.new_or_returning = 'returning';
    return { id: 'c1' } as Contact;
  });
  const state = baseState();
  state.metadata.reception_intake_phone_first = true;
  const result = await tryDeterministicIntakeCapture({
    state,
    content: '611000000',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  const { insertMessage } = await import('@/lib/db/messages');
  expect(vi.mocked(insertMessage)).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringMatching(/tratamiento|limpieza|revisión/i),
    }),
  );
});

function stateWithIdentityAndService() {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '+34678123456';
  state.patient.new_or_returning = 'new';
  state.appointment.service_type = 'limpieza';
  return state;
}

test('disponibilidad abierta: la primera disponible guarda y acusa recibo', async () => {
  const state = stateWithIdentityAndService();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'la primera disponible',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.appointment.preferred_date).toBe(EARLIEST_AVAILABLE_PREFERRED_DATE);
  expect(state.appointment.preferred_time).toBe('flexible');
  expect(state.appointment.flexibility).toBe('flexible');
  const { insertMessage } = await import('@/lib/db/messages');
  const payload = vi.mocked(insertMessage).mock.calls[0][0];
  expect(payload.content.trim().length).toBeGreaterThan(0);
  expect(payload.content).toMatch(/primera disponibilidad/i);
});

test('disponibilidad abierta: lo antes posible mismo comportamiento', async () => {
  const state = stateWithIdentityAndService();
  await tryDeterministicIntakeCapture({
    state,
    content: 'lo antes posible',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(state.appointment.preferred_date).toBe(EARLIEST_AVAILABLE_PREFERRED_DATE);
  expect(state.appointment.preferred_time).toBe('flexible');
});

test('disponibilidad abierta: cuando haya hueco mismo comportamiento', async () => {
  const state = stateWithIdentityAndService();
  await tryDeterministicIntakeCapture({
    state,
    content: 'cuando haya hueco',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  expect(state.appointment.preferred_date).toBe(EARLIEST_AVAILABLE_PREFERRED_DATE);
  expect(state.appointment.preferred_time).toBe('flexible');
});

test('disponibilidad abierta: siempre hay texto de respuesta', async () => {
  const state = stateWithIdentityAndService();
  await tryDeterministicIntakeCapture({
    state,
    content: 'cualquier día',
    conversation_id: 'cid',
    contact: { id: 'c1' } as Contact,
    getConversationById: async () => ({}),
  });
  const { insertMessage } = await import('@/lib/db/messages');
  const content = vi.mocked(insertMessage).mock.calls[0][0].content as string;
  expect(content.trim().length).toBeGreaterThan(5);
});
