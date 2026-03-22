export const LIMITS = {
  MAX_MESSAGE_LENGTH: 4000,
  CONTEXT_WINDOW: 20,
  MAX_MESSAGES_PER_MINUTE: 20,
  /** Broad per-IP cap on POST /api/chat (session limit remains the tight gate). */
  MAX_CHAT_MESSAGES_PER_IP_PER_MINUTE: 100,
  /** Staff list endpoint — per-IP to limit abuse even with a valid session. */
  CONVERSATIONS_LIST_PER_IP_PER_MINUTE: 120,
  MAX_TURNS_BEFORE_ESCALATION: 20,
} as const;

export function getAIGreeting(): string {
  const name = process.env.NEXT_PUBLIC_CLINIC_NAME ?? "nuestra clínica dental";
  return `¡Hola! Bienvenido a ${name}. Estoy aquí para ayudarte con citas, preguntas sobre nuestros servicios, seguros o cualquier otra consulta. ¿En qué puedo ayudarte hoy?`;
}
