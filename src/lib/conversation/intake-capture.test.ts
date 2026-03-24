import { beforeEach, expect, test, vi } from 'vitest';
import { tryDeterministicIntakeCapture } from './intake-capture';

vi.mock('@/services/conversation.service', () => ({
  saveState: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/messages', () => ({
  insertMessage: vi.fn(async () => ({ id: 'm1' })),
}));

beforeEach(async () => {
  const { insertMessage } = await import('@/lib/db/messages');
  vi.mocked(insertMessage).mockClear();
});

const baseState = (intent = 'appointment_request') => ({
  current_intent: intent,
  patient: { full_name: null, phone: null, email: null, new_or_returning: null },
  appointment: {},
  symptoms: {},
  metadata: {},
});

test('captura nombre válido', async () => {
  const state = baseState();
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'Juan Pérez',
    conversation_id: 'cid',
    contact: {},
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
    contact: {},
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
