import type { TurnResult } from '@/lib/conversation/engine';
import type { Contact, Conversation, Message } from '@/types/database';

export interface ChatTurnInput {
  session_token: string;
  conversation_id: string;
  content: string;
}

export interface ChatTurnResult {
  message: Message;
  contact: Contact;
  conversation: Conversation;
  /** null when the LLM output failed to parse and a fallback message was sent */
  turnResult: TurnResult | null;
}

/** Payload after HTTP/session guards and patient message persistence (core turn engine). */
export type ExecuteProcessChatTurnInput = {
  conversation_id: string;
  content: string;
  routedContent: string;
  conversation: Conversation;
  contact: Contact;
  patientMessage: Message;
};
