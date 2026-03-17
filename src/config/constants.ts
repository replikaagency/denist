export const LIMITS = {
  MAX_MESSAGE_LENGTH: 4000,
  CONTEXT_WINDOW: 20,
  MAX_MESSAGES_PER_MINUTE: 20,
  MAX_TURNS_BEFORE_ESCALATION: 20,
} as const;

export function getAIGreeting(): string {
  const name = process.env.NEXT_PUBLIC_CLINIC_NAME ?? "our dental office";
  return `Hi! Welcome to ${name}. I'm here to help you with appointments, questions about our services, insurance, or anything else. How can I help you today?`;
}
