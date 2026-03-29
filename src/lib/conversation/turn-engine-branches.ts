/**
 * Single source of truth for **`turn_engine.branch`** ids (`branch_taken` in structured logs and
 * `turn_engine_branch_events`). Emitters should import these constants — do not invent strings ad hoc.
 *
 * This file does **not** define:
 * - **`turnPhaseComplete(..., { branchTaken })`** — legacy internal phase metadata (separate naming).
 * - **`conversation_flow`** / `logConversationFlow` — historical parallel channel with its own `branch_taken` strings.
 */

export const TurnEngineBranch = {
  coordinator: {
    pipelineStart: 'coordinator.pipeline_start',
    yieldIntake: 'coordinator.yield_intake',
    yieldPostBooking: 'coordinator.yield_post_booking',
    yieldLlm: 'coordinator.yield_llm',
    deterministicIntake: 'deterministic_intake',
  },
  booking: {
    pathChoiceInvalid: 'booking.path_choice_invalid',
    quickEntryPathChoice: 'booking.quick_entry_path_choice',
    quickEntryReception: 'booking.quick_entry_reception',
    pathDirectLink: 'booking.path_direct_link',
    pathDirectReceptionPrompt: 'booking.path_direct_reception_prompt',
    pathReceptionPrompt: 'booking.path_reception_prompt',
    asapSlotSelected: 'booking.asap_slot_selected',
    asapSlotInvalid: 'booking.asap_slot_invalid',
    receptionPhoneRequired: 'booking.reception_phone_required',
    socialGreeting: 'booking.social_greeting',
    simpleInfo: 'booking.simple_info',
    socialGoodbye: 'booking.social_goodbye',
    socialAck: 'booking.social_ack',
    /** Legacy id (no `booking.` prefix); kept for log continuity. */
    socialThanks: 'social_thanks',
    rescheduleTargetLockedDirect: 'booking.reschedule_target_locked_direct',
    rescheduleAborted: 'booking.reschedule_aborted',
    rescheduleSelectionRetry: 'booking.reschedule_selection_retry',
    rescheduleSelectionOutOfRange: 'booking.reschedule_selection_out_of_range',
    rescheduleTargetLockedNumeric: 'booking.reschedule_target_locked_numeric',
    postCompletionEmailStrict: 'booking.post_completion_email_strict',
    postCompletionEmailYes: 'booking.post_completion_email_yes',
    postCompletionEmailNo: 'booking.post_completion_email_no',
    postCompletionCorrection: 'booking.post_completion_correction',
    offerDeclined: 'booking.offer_declined',
    frustrationHandoff: 'booking.frustration_handoff',
    receptionGateFallback: 'booking.reception_gate_fallback',
  },
  confirmation: {
    ttlExpired: 'confirmation.ttl_expired',
    mixedIntentDetected: 'confirmation.mixed_intent_detected',
    changeIntentDetected: 'confirmation.change_intent_detected',
    ambiguousDetected: 'confirmation.ambiguous_detected',
    unrelatedIntentBlocked: 'confirmation.unrelated_intent_blocked',
    persistedYes: 'confirmation.persisted_yes',
    persistFailed: 'confirmation.persist_failed',
    declinedReschedule: 'confirmation.declined_reschedule',
    declinedNew: 'confirmation.declined_new',
    escalatedAmbiguous: 'confirmation.escalated_ambiguous',
    clarify: 'confirmation.clarify',
    interceptFallback: 'confirmation.intercept_fallback',
  },
  hybrid: {
    skipped: 'hybrid.skipped',
    pathEntered: 'hybrid.path_entered',
    successDirectLink: 'hybrid.success_direct_link',
    successAvailability: 'hybrid.success_availability',
    rejectedDirectLink: 'hybrid.rejected_direct_link',
    fallbackAck: 'hybrid.fallback_ack',
    twoWayOfferShown: 'hybrid.two_way_offer_shown',
    twoWayOfferNoop: 'hybrid.two_way_offer_noop',
    processNoop: 'hybrid.process_noop',
    stateRefreshFailed: 'hybrid.state_refresh_failed',
    persistFailed: 'hybrid.persist_failed',
  },
  llm: {
    callFailed: 'llm.call_failed',
    parseRecoverGreeting: 'llm.parse_recover_greeting',
    parseRecoverInfo: 'llm.parse_recover_info',
    parseRecoverPathGate: 'llm.parse_recover_path_gate',
    parseRecoverGuidedField: 'llm.parse_recover_guided_field',
    parseRecoverIntake: 'llm.parse_recover_intake',
    parseRecoverGeneric: 'llm.parse_recover_generic',
    okContinue: 'llm.ok_continue',
  },
  sideEffects: {
    persistReply: 'side_effects.persist_reply',
  },
  intake: {
    asapSlotsOffered: 'intake.asap_slots_offered',
    corpusBackfill: 'intake.corpus_backfill',
    bookingShortcut: 'intake.booking_shortcut',
    requiredFieldRefusal: 'intake.required_field_refusal',
    openAvailability: 'intake.open_availability',
    fullNameIncomplete: 'intake.full_name_incomplete',
    fullNameCaptured: 'intake.full_name_captured',
    phoneCaptured: 'intake.phone_captured',
    newOrReturningPrompt: 'intake.new_or_returning_prompt',
    newOrReturningCaptured: 'intake.new_or_returning_captured',
    newOrReturningYes: 'intake.new_or_returning_yes',
    newOrReturningNo: 'intake.new_or_returning_no',
    preferredTimeExactPrompt: 'intake.preferred_time_exact_prompt',
    preferredTimeCaptured: 'intake.preferred_time_captured',
  },
} as const;

type LeafValues<T> = T extends string ? T : { [K in keyof T]: LeafValues<T[K]> }[keyof T];

/** Every allowed `branch_taken` string emitted via `logTurnEngineBranch`. */
export type TurnEngineBranchId = LeafValues<typeof TurnEngineBranch>;

/**
 * Logger event name for `turn_engine.branch` rows (keep aligned with dashboards / log queries).
 */
export const TURN_ENGINE_BRANCH_LOG_EVENT = 'turn_engine.branch' as const;

/**
 * Namespace segment before the dot in `branch_taken` (used for `current_step` and filters).
 */
export const TurnEngineBranchNamespace = {
  coordinator: 'coordinator',
  booking: 'booking',
  confirmation: 'confirmation',
  hybrid: 'hybrid',
  llm: 'llm',
  sideEffects: 'side_effects',
  intake: 'intake',
} as const;

/** Prefix for coordinator yield branches (`coordinator.yield_*`). */
export const COORDINATOR_YIELD_BRANCH_PREFIX = `${TurnEngineBranchNamespace.coordinator}.yield_` as const;
