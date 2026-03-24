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

type DbErrorLike = {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  table?: unknown;
  schema?: unknown;
  constraint?: unknown;
  column?: unknown;
  function?: unknown;
  routine?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractDbErrorInfo(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const dbError = error as DbErrorLike;
  return {
    ...(asString(dbError.message) ? { db_message: asString(dbError.message) } : {}),
    ...(asString(dbError.code) ? { db_code: asString(dbError.code) } : {}),
    ...(asString(dbError.details) ? { db_details: asString(dbError.details) } : {}),
    ...(asString(dbError.hint) ? { db_hint: asString(dbError.hint) } : {}),
    ...(asString(dbError.table) ? { db_table: asString(dbError.table) } : {}),
    ...(asString(dbError.schema) ? { db_schema: asString(dbError.schema) } : {}),
    ...(asString(dbError.constraint) ? { db_constraint: asString(dbError.constraint) } : {}),
    ...(asString(dbError.column) ? { db_column: asString(dbError.column) } : {}),
    ...(asString(dbError.function) ? { db_function: asString(dbError.function) } : {}),
    ...(asString(dbError.routine) ? { db_routine: asString(dbError.routine) } : {}),
  };
}
