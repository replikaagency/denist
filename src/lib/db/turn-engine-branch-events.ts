import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { log } from '@/lib/logger';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';

/**
 * Persists a turn_engine.branch row for SQL dashboards (no PII).
 * Skips when Supabase env is missing; errors are logged and never thrown.
 */
export function persistTurnEngineBranchEvent(params: {
  conversationId: string;
  branchTaken: TurnEngineBranchId;
  currentStep: string;
  allowLlm: boolean;
}): void {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return;
  }

  void (async () => {
    try {
      const { error } = await createSupabaseAdminClient()
        .from('turn_engine_branch_events')
        .insert({
          conversation_id: params.conversationId,
          branch_taken: params.branchTaken,
          current_step: params.currentStep,
          allow_llm: params.allowLlm,
        });

      if (error) {
        log('error', 'turn_engine_branch_event.insert_failed', {
          conversation_id: params.conversationId,
          branch_taken: params.branchTaken,
          message: error.message,
        });
      }
    } catch (err) {
      log('error', 'turn_engine_branch_event.insert_exception', {
        conversation_id: params.conversationId,
        branch_taken: params.branchTaken,
        error: err instanceof Error ? err.message : err,
      });
    }
  })();
}
