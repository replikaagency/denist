// =============================================================================
// Minimal structured logging for server-side code (JSON lines).
// =============================================================================

export type LogLevel = 'error' | 'warn' | 'info';

export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
