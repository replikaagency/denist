/**
 * Shared context for chat turn phase handlers (mutable refs + read-only turn inputs).
 */

import type { callLLM } from '@/lib/ai/completion';
import type { ChatTurnResult } from '@/lib/conversation/chat-turn-types';
import type { TurnResult } from '@/lib/conversation/engine';
import type { ConversationState } from '@/lib/conversation/schema';
import type { AppointmentRequest, Contact, Conversation, Message } from '@/types/database';

/** Unified return contract for every turn phase (coordinator branches on `handled` / `stopProcessing`). */
export type TurnPhaseResult = {
  handled: boolean;
  replyText?: string;
  nextStatePatch?: Record<string, unknown>;
  stopProcessing?: boolean;
  /** Internal phase tag only; not propagated to HTTP/`ChatTurnResult`. Not official telemetry — see `docs/TELEMETRY_CHANNELS.md`. */
  branchTaken?: string;
  /** When `stopProcessing` is true: persisted turn result (early exit). */
  outcome?: ChatTurnResult;
  /** When continuing from LLM phase into side-effects. */
  llmContinue?: LlmPhaseContinuePayload;
};

export type LlmPhaseContinuePayload = {
  turnResult: TurnResult;
  history: Message[];
  llmResult: Awaited<ReturnType<typeof callLLM>>;
};

export function turnPhaseNotHandled(): TurnPhaseResult {
  return { handled: false };
}

/**
 * Phase outcome helper. Optional `branchTaken` is internal phase metadata only — not `TurnEngineBranch` and not the official telemetry contract (`docs/TELEMETRY_CHANNELS.md`).
 */
export function turnPhaseComplete(
  outcome: ChatTurnResult,
  options?: { branchTaken?: string },
): TurnPhaseResult {
  return {
    handled: true,
    stopProcessing: true,
    outcome,
    branchTaken: options?.branchTaken,
    replyText: outcome.message.content,
  };
}

export function turnPhaseContinueWithLlm(payload: LlmPhaseContinuePayload): TurnPhaseResult {
  return {
    handled: true,
    stopProcessing: false,
    llmContinue: payload,
    replyText: payload.turnResult.reply,
  };
}

/** If the phase finished the turn (persisted AI reply), returns the HTTP result; otherwise `null`. */
export function takeCompletedTurnResult(phase: TurnPhaseResult): ChatTurnResult | null {
  if (phase.handled && phase.stopProcessing && phase.outcome) return phase.outcome;
  return null;
}

export type TurnPhaseRefs = {
  conversation: Conversation;
  contact: Contact;
  effectiveContactId: string;
};

/** Carried through the coordinator; phases mutate `refs` when they update identity or conversation row. */
export type TurnPhaseEnv = {
  conversation_id: string;
  content: string;
  routedContent: string;
  patientMessage: Message;
  state: ConversationState;
  stateMeta: Record<string, unknown>;
  refs: TurnPhaseRefs;
  /** From pre-turn sync; reused by post-LLM appointment / reschedule logic. */
  preExistingRequest: AppointmentRequest | null;
};
