// =============================================================================
// Typed application errors — used by DB helpers and route handlers
// =============================================================================

export type AppErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'DATABASE_ERROR'
  | 'AI_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  DATABASE_ERROR: 500,
  AI_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS[code];
    this.details = details;
  }

  static notFound(entity: string, id?: string): AppError {
    const msg = id ? `${entity} '${id}' not found` : `${entity} not found`;
    return new AppError('NOT_FOUND', msg);
  }

  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message);
  }

  static database(message: string, details?: unknown): AppError {
    return new AppError('DATABASE_ERROR', message, details);
  }

  static ai(message: string, details?: unknown): AppError {
    return new AppError('AI_ERROR', message, details);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
