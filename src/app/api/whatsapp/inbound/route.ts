import { NextRequest, NextResponse } from "next/server";
import { resolveContact } from "@/services/contact.service";
import { startOrResumeConversation, loadState, saveState, updateConversation } from "@/services/conversation.service";
import { processChatMessage } from "@/services/chat.service";
import { AppError } from "@/lib/errors";

// WhatsApp sessions can span days; stale confirmation state that slipped past the
// 30-min web-chat TTL (especially legacy rows where confirmation_prompt_at is null)
// must be cleared before we call processChatMessage, or the new message will be
// swallowed by the awaiting_confirmation intercept instead of reaching the LLM.
const WHATSAPP_CONFIRMATION_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

const FALLBACK =
  "En este momento no puedo responder automáticamente. Te contactaremos en breve.";

// Sent when the conversation is in human-handoff (ai_enabled=false).
// Instructs the patient to wait or type "reanudar" to resume AI.
const HANDOFF_LOCK_MESSAGE =
  'Te paso con el equipo de la clínica 👍\nTe responderán en cuanto puedan.\n\nSi quieres seguir hablando conmigo, escribe "reanudar".';

// Sent after the patient types "reanudar" and we re-enable the AI.
const RESUME_MESSAGE = "Perfecto, seguimos 😊\n¿En qué te ayudo?";

function twiml(text: string): NextResponse {
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${text}</Message>\n</Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const body = ((formData.get("Body") as string) ?? "").trim();
  const fromRaw = (formData.get("From") as string) ?? "";
  const profileName = (formData.get("ProfileName") as string) ?? "";
  const phone = fromRaw.replace("whatsapp:", "");

  console.log("[whatsapp/inbound]", { phone, profileName, body: body.slice(0, 120) });

  if (!body || !phone) return twiml(FALLBACK);

  // Detect resume keyword before entering the main flow so we can unlock a
  // handed-off conversation even before processChatMessage is called.
  const isResume = body.toLowerCase().trim() === "reanudar";

  try {
    const contact = await resolveContact({ channel: "whatsapp", phone });
    const { conversation, isNew } = await startOrResumeConversation(contact.id);

    // Clear stale confirmation state on resumed conversations before processChatMessage
    // sees it. Two cases that bypass the existing 30-min web-chat expiry:
    //   1. confirmation_prompt_at is null (legacy row) → backfill in chat.service sets
    //      it to "now" → expiry never fires → new message misrouted as a confirmation reply.
    //   2. confirmation_prompt_at exists but is older than 2 h (async WhatsApp gap).
    if (!isNew) {
      const state = await loadState(conversation.id);
      if (state.awaiting_confirmation) {
        const promptMs = state.confirmation_prompt_at
          ? new Date(state.confirmation_prompt_at).getTime()
          : 0; // null → treat as epoch → always stale
        if (Date.now() - promptMs > WHATSAPP_CONFIRMATION_STALE_MS) {
          state.awaiting_confirmation = false;
          state.pending_appointment = null;
          state.confirmation_prompt_at = null;
          state.confirmation_attempts = 0;
          await saveState(conversation.id, state);
          console.log("[whatsapp/inbound] cleared stale confirmation state", { conversationId: conversation.id });
        }
      }
    }

    try {
      const result = await processChatMessage({
        session_token: contact.session_token,
        conversation_id: conversation.id,
        content: body,
      });
      return twiml(result.message.content);
    } catch (innerErr) {
      // Conversation is handed off (ai_enabled=false / status waiting_human / human_active).
      // Do NOT create a fresh conversation automatically — that bypasses the handoff.
      // Instead: lock and instruct the patient to wait, or re-enable AI if they said "reanudar".
      if (innerErr instanceof AppError && innerErr.code === "CONFLICT") {
        if (isResume) {
          await updateConversation(conversation.id, { ai_enabled: true, status: "active" });
          console.log("[whatsapp/inbound] resumed handed-off conversation", { conversationId: conversation.id });
          return twiml(RESUME_MESSAGE);
        }
        console.log("[whatsapp/inbound] handoff lock — conversation is handed off", { conversationId: conversation.id });
        return twiml(HANDOFF_LOCK_MESSAGE);
      }
      throw innerErr; // re-throw non-CONFLICT errors to outer catch
    }
  } catch (err) {
    console.error("[whatsapp/inbound] error", err);
    return twiml(FALLBACK);
  }
}
