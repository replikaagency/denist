/**
 * Structured turn pipeline logs for production debugging (JSON via `log()`).
 * `branch_taken` MUST be `namespace.branch_id` (stable, queryable; ids live in `turn-engine-branches.ts`).
 * `current_step` in logs = namespace (segment before `.`).
 * Patient text is sanitized (PII patterns masked) then truncated — aligned with flow-logger phone masking.
 */

import type { ConversationState } from '@/lib/conversation/schema';
import { TURN_ENGINE_BRANCH_LOG_EVENT, type TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { peekFlowStep } from '@/lib/conversation/flow-rules';
import { persistTurnEngineBranchEvent } from '@/lib/db/turn-engine-branch-events';
import { log } from '@/lib/logger';

const INPUT_SUMMARY_MAX = 240;

/** Same idea as `maskPhoneForLog` in flow-logger: last 4 digits only. */
function maskDigitsToLastFour(digits: string): string {
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

/**
 * Masks email-shaped tokens; runs before phone pass so `@` / `.` do not confuse digit runs.
 */
function maskEmailsInText(text: string): string {
  return text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (raw) => {
      const at = raw.indexOf('@');
      if (at <= 0) return '***@***';
      const local = raw.slice(0, at);
      const rest = raw.slice(at + 1);
      const lastDot = rest.lastIndexOf('.');
      const tld = lastDot >= 0 ? rest.slice(lastDot) : '';
      const domain = lastDot >= 0 ? rest.slice(0, lastDot) : rest;
      const localPart = local.length ? `${local[0]}***` : '***';
      const domainPart = domain.length ? `${domain[0]}***` : '***';
      return `${localPart}@${domainPart}${tld}`;
    },
  );
}

/**
 * Masks common phone shapes in free text (ES + generic international), without masking ISO-like dates.
 */
function maskPhoneLikeSequencesInText(text: string): string {
  let t = text;
  // +34XXXXXXXXX (compact)
  t = t.replace(/\+34\d{9}\b/g, (m) => maskDigitsToLastFour(m.replace(/\D/g, '')));
  // +34 XXX XXX XXX
  t = t.replace(/\+34[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{3}\b/g, (m) =>
    maskDigitsToLastFour(m.replace(/\D/g, '')),
  );
  // 0034…
  t = t.replace(/0034[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{3}\b/g, (m) =>
    maskDigitsToLastFour(m.replace(/\D/g, '')),
  );
  // Spanish 9-digit mobile / landline (no leading 0)
  t = t.replace(/\b[6789]\d{8}\b/g, (m) => maskDigitsToLastFour(m));
  t = t.replace(/\b[6789]\d{2}[\s\-]\d{3}[\s\-]\d{3}\b/g, (m) =>
    maskDigitsToLastFour(m.replace(/\D/g, '')),
  );
  // Other international +E… (min length avoids short false positives)
  t = t.replace(/\+\d{10,15}\b/g, (m) => maskDigitsToLastFour(m.replace(/\D/g, '')));
  return t;
}

/**
 * Safe one-line preview for logs: mask PII-shaped substrings, then cap length.
 * Exported for unit tests.
 */
export function sanitizeInputSummaryForLog(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const maskedEmail = maskEmailsInText(trimmed);
  const masked = maskPhoneLikeSequencesInText(maskedEmail);
  if (masked.length <= INPUT_SUMMARY_MAX) return masked;
  return `${masked.slice(0, INPUT_SUMMARY_MAX)}…`;
}

function currentStepFromBranch(branchTaken: string | undefined): string {
  const s = typeof branchTaken === 'string' ? branchTaken : '';
  const dot = s.indexOf('.');
  return dot === -1 ? s : s.slice(0, dot);
}

export type TurnEngineBranchPayload = {
  conversationId: string;
  /** Stable id: `coordinator.*` | `intake.*` | `booking.*` | `confirmation.*` | `hybrid.*` | `llm.*` | `side_effects.*` */
  branchTaken: TurnEngineBranchId;
  reason: string;
  inputSummary: string;
  state: ConversationState;
};

export function logTurnEngineBranch(payload: TurnEngineBranchPayload): void {
  const flow = peekFlowStep(payload.state);
  const branchTaken = payload.branchTaken ?? '';
  log('info', TURN_ENGINE_BRANCH_LOG_EVENT, {
    conversation_id: payload.conversationId,
    current_step: currentStepFromBranch(branchTaken),
    branch_taken: branchTaken,
    reason: payload.reason,
    input_summary: sanitizeInputSummaryForLog(payload.inputSummary),
    resulting_next_step: `${flow.step}:${flow.reason}`,
    allow_llm: flow.allowLLM,
  });

  persistTurnEngineBranchEvent({
    conversationId: payload.conversationId,
    branchTaken: payload.branchTaken,
    currentStep: currentStepFromBranch(branchTaken),
    allowLlm: flow.allowLLM,
  });
}
