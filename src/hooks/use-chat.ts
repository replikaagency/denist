'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

interface ChatMessage {
  id: string;
  role: 'patient' | 'ai' | 'human' | 'system';
  content: string;
  created_at: string;
}

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  conversationId: string | null;
  contact: Contact | null;
  conversationStatus: string | null;
  sendMessage: (content: string) => Promise<void>;
  startChat: () => Promise<void>;
  clearError: () => void;
}

const SESSION_TOKEN_KEY = 'dental_ai_session_token';

function getOrCreateSessionToken(): string {
  if (typeof window === 'undefined') return '';
  let token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  }
  return token;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [conversationStatus, setConversationStatus] = useState<string | null>(null);

  const sessionTokenRef = useRef<string>('');

  useEffect(() => {
    sessionTokenRef.current = getOrCreateSessionToken();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const startChat = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = sessionTokenRef.current || getOrCreateSessionToken();
      sessionTokenRef.current = token;

      const res = await fetch('/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token }),
      });

      const json = await res.json();
      if (!json.ok) {
        throw new Error(json.error?.message ?? 'Failed to start chat');
      }

      const { conversation, contact: contactData, messages: initialMessages } = json.data;
      setConversationId(conversation.id);
      setContact(contactData);
      setConversationStatus(conversation.status);

      // `messages` is always returned: [greeting] for new conversations,
      // or recent history for resumed ones. No separate staff-auth fetch needed.
      if (Array.isArray(initialMessages) && initialMessages.length > 0) {
        setMessages(
          (initialMessages as ChatMessage[]).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start chat');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversationId || isSending) return;

      const trimmed = content.trim();
      if (!trimmed) return;

      // Optimistic: add patient message immediately
      const tempId = `temp-${Date.now()}`;
      const patientMsg: ChatMessage = {
        id: tempId,
        role: 'patient',
        content: trimmed,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, patientMsg]);
      setIsSending(true);
      setError(null);

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_token: sessionTokenRef.current,
            conversation_id: conversationId,
            content: trimmed,
          }),
        });

        const json = await res.json();
        if (!json.ok) {
          throw new Error(json.error?.message ?? 'Failed to send message');
        }

        const { message: aiMessage, contact: updatedContact, conversation } = json.data;

        // Replace temp patient msg ID and add AI response
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === tempId ? { ...m, id: `patient-${aiMessage.id}` } : m,
          );
          return [
            ...updated,
            {
              id: aiMessage.id,
              role: aiMessage.role,
              content: aiMessage.content,
              created_at: aiMessage.created_at,
            },
          ];
        });

        if (updatedContact) setContact(updatedContact);
        if (conversation) setConversationStatus(conversation.status);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message');
        // Remove optimistic message on failure
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
      } finally {
        setIsSending(false);
      }
    },
    [conversationId, isSending],
  );

  return {
    messages,
    isLoading,
    isSending,
    error,
    conversationId,
    contact,
    conversationStatus,
    sendMessage,
    startChat,
    clearError,
  };
}
