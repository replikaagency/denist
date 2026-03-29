/**
 * Entry Booking Gate — strict binary patient-status resolution
 *
 * Called from process-chat-turn when a prefilled booking_request entry has been
 * detected (stateMeta.booking_patient_status_pending === true) and the patient
 * has not yet declared their status (new vs returning).
 *
 * This gate runs BEFORE awaiting_confirmation so confirmation always wins.
 * It clears itself (booking_patient_status_pending = false) once status is resolved
 * and falls the turn through to the existing booking flow.
 */

import { insertMessage } from '@/lib/db/messages';
import { findContactByPhone } from '@/lib/db/contacts';
import { saveState, getConversationById } from '@/services/conversation.service';
import { normalizePhone } from '@/lib/phone';
import { extractNewOrReturningGuard } from './intake-guards';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import {
  ENTRY_BOOKING_GATE_REPROMPT,
  ENTRY_BOOKING_RETURNING_ASK_PHONE,
  ENTRY_BOOKING_RETURNING_FOUND,
  ENTRY_BOOKING_RETURNING_NOT_FOUND,
  ENTRY_BOOKING_RETURNING_AMBIGUOUS,
  ENTRY_BOOKING_NEW_ASK_DETAILS,
  ENTRY_BOOKING_PATIENT_STATUS_OPTIONS,
} from './response-builder';
import type { ChatTurnResult } from '@/lib/conversation/chat-turn-types';
import type { ConversationState } from '@/lib/conversation/schema';
import type { Contact } from '@/types/database';

// ---------------------------------------------------------------------------
// Minimal env interface — we don't depend on TurnPhaseEnv so the gate can
// be called before the full env is constructed in process-chat-turn.
// ---------------------------------------------------------------------------

export interface BookingGateEnv {
  conversation_id: string;
  routedContent: string;
  state: ConversationState;
  contact: Contact;
}

type GateResult =
  | { handled: true; result: ChatTurnResult }
  | { handled: false };

// ---------------------------------------------------------------------------
// Patient status detection
// ---------------------------------------------------------------------------

function extractPatientEntryStatus(content: string): 'new' | 'returning' | null {
  const t = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Button values (from UI metadata)
  if (t === 'patient_status_returning') return 'returning';
  if (t === 'patient_status_new') return 'new';

  // Returning signals
  if (
    /\bya soy paciente\b/.test(t) ||
    /\bya he venido\b/.test(t) ||
    /\bsoy paciente\b/.test(t) ||
    /\bpaciente existente\b/.test(t)
  ) {
    return 'returning';
  }

  // New patient signals
  if (
    /\bes mi primera vez\b/.test(t) ||
    /\bprimera vez\b/.test(t) ||
    /\bsoy nuevo\b/.test(t) ||
    /\bsoy nueva\b/.test(t) ||
    /\bno he venido\b/.test(t) ||
    /\bnuevo paciente\b/.test(t) ||
    /\bnueva paciente\b/.test(t)
  ) {
    return 'new';
  }

  // Fall back to the generic intake guard which handles more variants
  return extractNewOrReturningGuard(content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getKnownPhone(state: ConversationState, contact: Contact): string | null {
  if (state.patient.phone) return state.patient.phone;
  if (typeof contact.phone === 'string' && contact.phone) {
    try { return normalizePhone(contact.phone); } catch { return null; }
  }
  return null;
}

async function replyWith(
  env: BookingGateEnv,
  content: string,
  metadata: Record<string, unknown>,
  branchReason: string,
): Promise<ChatTurnResult> {
  await saveState(env.conversation_id, env.state);
  const aiMessage = await insertMessage({
    conversation_id: env.conversation_id,
    role: 'ai',
    content,
    metadata,
  });
  logTurnEngineBranch({
    conversationId: env.conversation_id,
    branchTaken: TurnEngineBranch.coordinator.pipelineStart,
    reason: branchReason,
    inputSummary: env.routedContent,
    state: env.state,
  });
  return {
    message: aiMessage,
    contact: env.contact,
    conversation: await getConversationById(env.conversation_id),
    turnResult: null,
  };
}

// ---------------------------------------------------------------------------
// Returning patient sub-flow
// ---------------------------------------------------------------------------

async function handleReturningPath(env: BookingGateEnv): Promise<ChatTurnResult | null> {
  const stateMeta = env.state.metadata as Record<string, unknown>;

  // Sub-phase: waiting for phone input
  if (stateMeta.booking_returning_awaiting_phone) {
    // Only attempt normalization if input looks like a phone number (≥6 digits)
    const digitCount = (env.routedContent.match(/\d/g) ?? []).length;
    const looksLikePhone = digitCount >= 6;

    const normalized = looksLikePhone
      ? (() => {
          const digits = env.routedContent.replace(/\s/g, '');
          try { return normalizePhone(digits); } catch { return null; }
        })()
      : null;

    if (!normalized) {
      return replyWith(
        env,
        ENTRY_BOOKING_RETURNING_ASK_PHONE,
        { type: 'entry_booking_gate', phase: 'returning_ask_phone' },
        'returning path: input not a valid phone, re-asking',
      );
    }

    env.state.patient.phone = normalized;
    delete stateMeta.booking_returning_awaiting_phone;
    return performPhoneLookup(env, normalized);
  }

  // First turn after declaring 'returning': check if phone already known
  const knownPhone = getKnownPhone(env.state, env.contact);
  if (knownPhone) {
    return performPhoneLookup(env, knownPhone);
  }

  // No phone known — ask for it
  stateMeta.booking_returning_awaiting_phone = true;
  return replyWith(
    env,
    ENTRY_BOOKING_RETURNING_ASK_PHONE,
    { type: 'entry_booking_gate', phase: 'returning_ask_phone' },
    'returning path: no phone in state, asking for phone',
  );
}

async function performPhoneLookup(env: BookingGateEnv, phone: string): Promise<ChatTurnResult> {
  const stateMeta = env.state.metadata as Record<string, unknown>;

  let found: Contact | null;
  try {
    found = await findContactByPhone(phone);
  } catch {
    // maybeSingle() throws on >1 row — treat as ambiguous (multi-match safety)
    stateMeta.booking_patient_status_pending = false;
    delete stateMeta.booking_returning_awaiting_phone;
    env.state.patient.new_or_returning = 'returning';
    return replyWith(
      env,
      ENTRY_BOOKING_RETURNING_AMBIGUOUS,
      { type: 'entry_booking_gate', phase: 'returning_ambiguous' },
      'returning path: multiple matches or DB error — asking for full name',
    );
  }

  if (!found) {
    stateMeta.booking_patient_status_pending = false;
    delete stateMeta.booking_returning_awaiting_phone;
    env.state.patient.new_or_returning = 'returning';
    return replyWith(
      env,
      ENTRY_BOOKING_RETURNING_NOT_FOUND,
      { type: 'entry_booking_gate', phase: 'returning_not_found' },
      'returning path: phone not found in DB — asking for full name',
    );
  }

  // Found — hydrate state from contact
  const name = [found.first_name, found.last_name].filter(Boolean).join(' ').trim();
  if (name && !env.state.patient.full_name) env.state.patient.full_name = name;
  if (!env.state.patient.new_or_returning) {
    env.state.patient.new_or_returning =
      typeof found.is_new_patient === 'boolean'
        ? (found.is_new_patient ? 'new' : 'returning')
        : 'returning';
  }

  // Clear gate — hand off to normal booking flow
  stateMeta.booking_patient_status_pending = false;
  delete stateMeta.booking_returning_awaiting_phone;

  return replyWith(
    env,
    ENTRY_BOOKING_RETURNING_FOUND,
    { type: 'entry_booking_gate', phase: 'returning_found' },
    'returning path: patient found by phone — gate cleared',
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Returns { handled: true, result } when this turn is consumed by the gate,
 * or { handled: false } to let the normal pipeline continue.
 */
export async function handleBookingEntryGate(env: BookingGateEnv): Promise<GateResult> {
  const stateMeta = env.state.metadata as Record<string, unknown>;

  if (!stateMeta.booking_patient_status_pending) return { handled: false };

  // Sub-phase: patient already said 'returning' on a prior turn → collecting phone
  if (stateMeta.booking_returning_awaiting_phone) {
    const result = await handleReturningPath(env);
    if (result) return { handled: true, result };
    return { handled: false };
  }

  // Detect patient status from current message
  const detected = extractPatientEntryStatus(env.routedContent);

  if (detected === 'returning') {
    env.state.patient.new_or_returning = 'returning';
    const result = await handleReturningPath(env);
    if (result) return { handled: true, result };
    // Phone resolved immediately — fall through
    stateMeta.booking_patient_status_pending = false;
    return { handled: false };
  }

  if (detected === 'new') {
    env.state.patient.new_or_returning = 'new';
    stateMeta.booking_patient_status_pending = false;
    const result = await replyWith(
      env,
      ENTRY_BOOKING_NEW_ASK_DETAILS,
      { type: 'entry_booking_gate', phase: 'new_ask_details' },
      'new patient path: asking for name + phone',
    );
    return { handled: true, result };
  }

  // Ambiguous / unrelated — track attempts; release after 3 to avoid infinite gate
  const attempts = ((stateMeta.booking_gate_attempts as number | undefined) ?? 0) + 1;
  stateMeta.booking_gate_attempts = attempts;

  if (attempts >= 3) {
    stateMeta.booking_patient_status_pending = false;
    delete stateMeta.booking_gate_attempts;
    return { handled: false };
  }

  const result = await replyWith(
    env,
    ENTRY_BOOKING_GATE_REPROMPT,
    {
      type: 'patient_status_choice',
      field: 'new_or_returning',
      options: ENTRY_BOOKING_PATIENT_STATUS_OPTIONS,
    },
    `booking gate: ambiguous reply (attempt ${attempts}/3) — re-prompting binary gate`,
  );
  return { handled: true, result };
}
