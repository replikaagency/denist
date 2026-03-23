import { describe, it, expect } from 'vitest';
import {
  extractPhoneGuard,
  extractEmailGuard,
  extractNameGuard,
  extractNewOrReturningGuard,
} from './intake-guards';

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------
describe('extractPhoneGuard', () => {
  it('bare 9-digit mobile', () => expect(extractPhoneGuard('612345678')).toBe('+34612345678'));
  it('mobile with spaces', () => expect(extractPhoneGuard('612 34 56 78')).toBe('+34612345678'));
  it('mobile with dashes', () => expect(extractPhoneGuard('612-345-678')).toBe('+34612345678'));
  it('+34 prefix', () => expect(extractPhoneGuard('+34612345678')).toBe('+34612345678'));
  it('+34 with spaces', () => expect(extractPhoneGuard('+34 612 345 678')).toBe('+34612345678'));
  it('0034 prefix', () => expect(extractPhoneGuard('0034612345678')).toBe('+34612345678'));
  it('landline 9xx', () => expect(extractPhoneGuard('956789012')).toBe('+34956789012'));
  it('embedded in sentence', () => expect(extractPhoneGuard('mi número es 666 777 888')).toBe('+34666777888'));
  it('null for plain text', () => expect(extractPhoneGuard('el martes')).toBeNull());
  it('null for 8 digits', () => expect(extractPhoneGuard('12345678')).toBeNull());
  it('null for number starting with 5', () => expect(extractPhoneGuard('512345678')).toBeNull());
  it('null for empty string', () => expect(extractPhoneGuard('')).toBeNull());
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
describe('extractEmailGuard', () => {
  it('plain email', () => expect(extractEmailGuard('test@example.com')).toBe('test@example.com'));
  it('embedded in sentence', () =>
    expect(extractEmailGuard('mi correo es maria@gmail.com gracias')).toBe('maria@gmail.com'));
  it('spanish domain .es', () => expect(extractEmailGuard('juan@clinica.es')).toBe('juan@clinica.es'));
  it('lowercases', () => expect(extractEmailGuard('MARIA@EXAMPLE.COM')).toBe('maria@example.com'));
  it('null for plain text', () => expect(extractEmailGuard('no tengo correo')).toBeNull());
  it('null for empty', () => expect(extractEmailGuard('')).toBeNull());
});

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------
describe('extractNameGuard', () => {
  it('prefixed: me llamo', () =>
    expect(extractNameGuard('me llamo María García')).toBe('María García'));
  it('prefixed: soy', () =>
    expect(extractNameGuard('soy Carlos López')).toBe('Carlos López'));
  it('bare two-word name', () =>
    expect(extractNameGuard('María García')).toBe('María García'));
  it('bare three-word name', () =>
    expect(extractNameGuard('Ana María Sánchez')).toBe('Ana María Sánchez'));
  it('capitalizes lowercase input', () =>
    expect(extractNameGuard('carlos rodriguez')).toBe('Carlos Rodriguez'));
  it('null for single stop word sí', () => expect(extractNameGuard('sí')).toBeNull());
  it('null for single stop word no', () => expect(extractNameGuard('no')).toBeNull());
  it('null for day name', () => expect(extractNameGuard('el lunes')).toBeNull());
  it('null for phone number', () => expect(extractNameGuard('612345678')).toBeNull());
  it('null for empty', () => expect(extractNameGuard('')).toBeNull());
});

// ---------------------------------------------------------------------------
// New or returning
// ---------------------------------------------------------------------------
describe('extractNewOrReturningGuard', () => {
  it('detects new: primera vez', () =>
    expect(extractNewOrReturningGuard('es mi primera vez')).toBe('new'));
  it('detects new: soy nuevo', () =>
    expect(extractNewOrReturningGuard('soy nuevo')).toBe('new'));
  it('detects new: nunca he venido', () =>
    expect(extractNewOrReturningGuard('nunca he venido antes')).toBe('new'));
  it('detects returning: ya soy paciente', () =>
    expect(extractNewOrReturningGuard('ya soy paciente vuestro')).toBe('returning'));
  it('detects returning: tengo ficha', () =>
    expect(extractNewOrReturningGuard('ya tengo ficha allí')).toBe('returning'));
  it('null for bare sí (ambiguous)', () => expect(extractNewOrReturningGuard('sí')).toBeNull());
  it('null for unrelated message', () =>
    expect(extractNewOrReturningGuard('quiero una limpieza')).toBeNull());
});

// ---------------------------------------------------------------------------
// Fallback NOT triggered when data is valid (contract test)
// Asserts that guards return non-null so callers skip the parse_error_fallback
// ---------------------------------------------------------------------------
describe('guards prevent fallback for valid inputs', () => {
  it('phone: 612345678 is captured, not null', () =>
    expect(extractPhoneGuard('612345678')).not.toBeNull());
  it('email: foo@bar.com is captured, not null', () =>
    expect(extractEmailGuard('foo@bar.com')).not.toBeNull());
  it('name: Juan García is captured, not null', () =>
    expect(extractNameGuard('Juan García')).not.toBeNull());
  it('new_or_returning: primera vez is captured, not null', () =>
    expect(extractNewOrReturningGuard('primera vez')).not.toBeNull());
});

// ---------------------------------------------------------------------------
// Sentence-embedded inputs
// ---------------------------------------------------------------------------
describe('sentence-embedded inputs', () => {
  it('phone embedded: "mi telefono es 612345678"', () =>
    expect(extractPhoneGuard('mi telefono es 612345678')).toBe('+34612345678'));

  it('email embedded: "mi correo es test@gmail.com"', () =>
    expect(extractEmailGuard('mi correo es test@gmail.com')).toBe('test@gmail.com'));

  it('name bare: "Juan Pérez"', () =>
    expect(extractNameGuard('Juan Pérez')).toBe('Juan Pérez'));

  it('name NOT extracted from generic phrase: "hola quiero cita"', () =>
    expect(extractNameGuard('hola quiero cita')).toBeNull());
});
