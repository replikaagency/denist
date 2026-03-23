import { tryDeterministicIntakeCapture } from './intake-capture';

const baseState = (intent = 'appointment_request') => ({
  current_intent: intent,
  patient: { full_name: null, phone: null, email: null, new_or_returning: null },
  appointment: {},
  symptoms: {},
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
  expect(state.patient.phone).toBe('678123456');
});

test('captura email válido', async () => {
  const state = baseState();
  state.patient.full_name = 'Juan Pérez';
  state.patient.phone = '678123456';
  const result = await tryDeterministicIntakeCapture({
    state,
    content: 'juan@gmail.com',
    conversation_id: 'cid',
    contact: {},
    getConversationById: async () => ({}),
  });
  expect(result).not.toBeNull();
  expect(state.patient.email).toBe('juan@gmail.com');
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
