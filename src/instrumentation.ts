import { assertServerEnv } from '@/lib/env';

export async function register(): Promise<void> {
  assertServerEnv();
}
