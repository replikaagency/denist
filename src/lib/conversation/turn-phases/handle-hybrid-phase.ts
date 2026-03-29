import { log } from '@/lib/logger';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';
import { getActiveHybridBookingForConversation } from '@/lib/db/hybrid-bookings';
import {
  appendHybridAckToReply,
  mergeAvailabilityCaptureReply,
  mergeDirectBookingChoiceReply,
  mergeHybridOfferTwoWaysReply,
  processHybridBookingTurn,
} from '@/services/hybrid-booking.service';
import type { TurnResult } from '@/lib/conversation/engine';
import type { Lead } from '@/types/database';

export type HybridPhaseParams = {
  conversation_id: string;
  routedContent: string;
  effectiveContactId: string;
  lead: Lead;
  isIdentified: boolean;
  hasOpenRequest: boolean;
  turnResult: TurnResult;
  bookingSelfServiceUrl: string;
  tryEmitBookingLinkShown: (path: string) => void;
};

function logHybridBranch(
  conversation_id: string,
  routedContent: string,
  state: TurnResult['state'],
  branchTaken: TurnEngineBranchId,
  reason: string,
): void {
  logTurnEngineBranch({
    conversationId: conversation_id,
    branchTaken,
    reason,
    inputSummary: routedContent,
    state,
  });
}

/**
 * Hybrid booking (direct link + structured availability) — new appointment_request only.
 * @returns `hybridDeferredStandardFlow` flag for downstream appointment guards.
 */
export async function applyHybridBookingPhase(p: HybridPhaseParams): Promise<boolean> {
  const {
    conversation_id,
    routedContent,
    effectiveContactId,
    lead,
    isIdentified,
    hasOpenRequest,
    turnResult,
    bookingSelfServiceUrl,
    tryEmitBookingLinkShown,
  } = p;

  const state = turnResult.state;

  if (turnResult.escalation.shouldEscalate) {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: turn is escalated (handoff or emergency path).',
    );
    return false;
  }
  if (!isIdentified) {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: patient not identified.',
    );
    return false;
  }
  if (!lead) {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: no lead on record.',
    );
    return false;
  }
  if (hasOpenRequest) {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: open appointment request already exists.',
    );
    return false;
  }
  if (state.current_intent !== 'appointment_request') {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: current_intent is not appointment_request.',
    );
    return false;
  }
  if (state.reschedule_phase !== 'idle') {
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.skipped,
      'Hybrid not run: reschedule flow active.',
    );
    return false;
  }

  let hybridDeferredStandardFlow = false;

  logHybridBranch(
    conversation_id,
    routedContent,
    state,
    TurnEngineBranch.hybrid.pathEntered,
    'Guards passed; invoking processHybridBookingTurn.',
  );

  try {
    const hybridResult = await processHybridBookingTurn({
      conversationId: conversation_id,
      contactId: effectiveContactId,
      leadId: lead.id,
      patientMessage: routedContent,
      state: turnResult.state,
      hybridSignal: turnResult.rawOutput.hybrid_booking,
      bookingSelfServiceUrl,
    });
    hybridDeferredStandardFlow = hybridResult.deferredStandardFlow;
    if (hybridDeferredStandardFlow) {
      turnResult.state.offer_appointment_pending = false;
      turnResult.state.awaiting_confirmation = false;
      turnResult.state.pending_appointment = null;
      turnResult.state.confirmation_prompt_at = null;
      turnResult.state.completed = false;
      const hbOut = turnResult.rawOutput.hybrid_booking;
      const choseLink =
        !!bookingSelfServiceUrl &&
        hbOut?.patient_declined_direct_link !== true &&
        (hbOut?.patient_chose_direct_link === true || hbOut?.booking_mode === 'direct_link');
      if (choseLink) {
        turnResult.reply = mergeDirectBookingChoiceReply(turnResult.reply, bookingSelfServiceUrl);
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.successDirectLink,
          'Deferred standard flow: direct self-service link merged into reply.',
        );
      } else if (hybridResult.capturePayload) {
        turnResult.reply = mergeAvailabilityCaptureReply(turnResult.reply, hybridResult.capturePayload);
        const cap = hybridResult.capturePayload;
        if (cap.service_interest && !turnResult.state.appointment.service_type) {
          turnResult.state.appointment.service_type = cap.service_interest;
        }
        if (cap.preferred_time_ranges.length && !turnResult.state.appointment.preferred_time) {
          const r0 = cap.preferred_time_ranges[0].toLowerCase();
          if (r0.includes('mañana') || r0.includes('manana')) {
            turnResult.state.appointment.preferred_time = 'morning';
          } else if (r0.includes('tarde')) {
            turnResult.state.appointment.preferred_time = 'afternoon';
          } else if (r0.includes('noche')) {
            turnResult.state.appointment.preferred_time = 'evening';
          } else {
            turnResult.state.appointment.preferred_time = cap.preferred_time_ranges[0].slice(0, 80);
          }
        }
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.successAvailability,
          'Deferred standard flow: availability capture merged and draft fields updated.',
        );
      } else if (hbOut?.patient_declined_direct_link === true) {
        turnResult.reply = appendHybridAckToReply(turnResult.reply);
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.rejectedDirectLink,
          'Deferred standard flow: patient declined direct link; hybrid ack appended.',
        );
      } else {
        turnResult.reply = appendHybridAckToReply(turnResult.reply);
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.fallbackAck,
          'Deferred standard flow: no link merge or capture payload; generic hybrid ack appended.',
        );
      }
    } else if (
      bookingSelfServiceUrl &&
      turnResult.rawOutput.hybrid_booking?.assistant_should_offer_choice &&
      !turnResult.state.hybrid_booking_open &&
      !turnResult.state.self_service_booking_offer_shown
    ) {
      const beforeHybridOffer = turnResult.reply.trim();
      const url = bookingSelfServiceUrl.trim();
      turnResult.reply = mergeHybridOfferTwoWaysReply(turnResult.reply, bookingSelfServiceUrl);
      if (
        turnResult.reply.trim() !== beforeHybridOffer ||
        (url && turnResult.reply.includes(url) && turnResult.reply.toLowerCase().includes('dos formas'))
      ) {
        turnResult.state.self_service_booking_offer_shown = true;
        tryEmitBookingLinkShown('llm_assistant_should_offer_choice');
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.twoWayOfferShown,
          'Appended two-way self-service vs callback offer to reply.',
        );
      } else {
        logHybridBranch(
          conversation_id,
          routedContent,
          state,
          TurnEngineBranch.hybrid.twoWayOfferNoop,
          'Assistant flagged offer_choice but reply text unchanged after merge.',
        );
      }
    } else {
      logHybridBranch(
        conversation_id,
        routedContent,
        state,
        TurnEngineBranch.hybrid.processNoop,
        'processHybridBookingTurn returned without deferred flow or two-way offer branch.',
      );
    }
    try {
      turnResult.state.hybrid_booking_open = !!(await getActiveHybridBookingForConversation(conversation_id));
    } catch (err) {
      log('error', 'hybrid_booking.fetch_failed', {
        conversation_id,
        phase: 'post_hybrid_refresh',
        error: err instanceof Error ? err.message : String(err),
      });
      logHybridBranch(
        conversation_id,
        routedContent,
        state,
        TurnEngineBranch.hybrid.stateRefreshFailed,
        'Could not refresh hybrid_booking_open after hybrid processing.',
      );
      turnResult.state.hybrid_booking_open = false;
    }
  } catch (err) {
    log('error', 'hybrid_booking.persist_failed', {
      conversation_id,
      phase: 'processHybridBookingTurn',
      error: err instanceof Error ? err.message : String(err),
    });
    logHybridBranch(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.hybrid.persistFailed,
      'processHybridBookingTurn threw; hybrid branch skipped.',
    );
    hybridDeferredStandardFlow = false;
    try {
      turnResult.state.hybrid_booking_open = !!(await getActiveHybridBookingForConversation(conversation_id));
    } catch {
      turnResult.state.hybrid_booking_open = false;
    }
  }

  return hybridDeferredStandardFlow;
}
