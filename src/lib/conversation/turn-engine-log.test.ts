import { describe, expect, it } from 'vitest';
import { sanitizeInputSummaryForLog } from './turn-engine-log';

describe('sanitizeInputSummaryForLog', () => {
  it('masks email tokens', () => {
    expect(sanitizeInputSummaryForLog('Escríbeme a oliver@gmail.com mañana')).toContain('o***@g***.com');
    expect(sanitizeInputSummaryForLog('Escríbeme a oliver@gmail.com mañana')).not.toContain('oliver@gmail');
  });

  it('masks +34 and spaced Spanish mobiles', () => {
    expect(sanitizeInputSummaryForLog('Llámame al +34600123456')).toBe('Llámame al ***3456');
    expect(sanitizeInputSummaryForLog('Mi número es 600 123 456')).toBe('Mi número es ***3456');
  });

  it('truncates long text after masking', () => {
    const long = `a`.repeat(300) + ' 600123456';
    const out = sanitizeInputSummaryForLog(long);
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not treat ISO dates as phones', () => {
    expect(sanitizeInputSummaryForLog('Cita el 2026-03-15 por la mañana')).toBe(
      'Cita el 2026-03-15 por la mañana',
    );
  });

  it('privacidad: input_summary no incluye teléfono ni email completos y conserva pistas para debug', () => {
    const rawPhoneDigits = '600123456';
    const msg = `Hola, escríbeme a ana.perez@clinica.es o al 600 123 456`;
    const out = sanitizeInputSummaryForLog(msg);

    expect(out).not.toContain(rawPhoneDigits);
    expect(out).not.toMatch(/\b600[\s-]?123[\s-]?456\b/);
    expect(out).not.toContain('ana.perez@');
    expect(out).not.toContain('clinica.es');

    expect(out).toContain('***3456');
    expect(out).toMatch(/a\*\*\*@c\*\*\*\.es/);
  });
});
