import { z } from 'zod/v4';

/** Patient session token from localStorage — must be a UUID (see use-chat / chat-ui). */
export const SessionTokenSchema = z.string().uuid();
