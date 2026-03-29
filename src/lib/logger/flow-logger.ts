import { log } from '@/lib/logger';

const MAX_INPUT_LEN = 240;

export type ConversationFlowLog = {
  conversation_id?: string;
  phone: string | null | undefined;
  step: string;
  input: string;
  branch_taken: string;
  reason: string;
};

/** Last 4 digits only — enough to correlate without full PII in log drains. */
export function maskPhoneForLog(phone: string | null | undefined): string | null {
  if (phone == null || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

export function truncateInputForLog(input: string, maxLen = MAX_INPUT_LEN): string {
  const t = input.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

/**
 * Single JSON-line event for tracing conversational branches in production.
 * Emits via `log()` — no direct console usage here.
 *
 * Historical `conversation_flow` channel: `branch_taken` here is not the same contract as `turn_engine.branch`
 * (see `turn-engine-branches.ts` / `TURN_ENGINE_OPERATIONS.md`).
 */
export function logConversationFlow(payload: ConversationFlowLog): void {
  const { conversation_id, phone, step, input, branch_taken, reason } = payload;
  log('info', 'conversation_flow', {
    ...(conversation_id ? { conversation_id } : {}),
    phone: maskPhoneForLog(phone),
    step,
    input: truncateInputForLog(input),
    branch_taken,
    reason,
  });
}
