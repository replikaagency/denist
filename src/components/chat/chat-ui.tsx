"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SendHorizonal, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ChatMessage, type Message } from "@/components/chat/chat-message";
import { useRealtimeMessages } from "@/hooks/use-realtime";

const SESSION_TOKEN_KEY = "dental_ai_session_token";

function getOrCreateSessionToken(): string {
  if (typeof window === "undefined") return "";
  let token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  }
  return token;
}

function getTime() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ChatUI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  // True once the conversation has been handed off to a human agent.
  // Disables the chat input and shows a waiting banner.
  const [isHandedOff, setIsHandedOff] = useState(false);
  // Two-step confirmation for "Start new conversation" — avoids accidental resets.
  const [confirmNew, setConfirmNew] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionTokenRef = useRef("");
  // Track message IDs we have already rendered to prevent duplicates on
  // realtime reconnect. Seeded with greeting id when the conversation starts.
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const startConversation = useCallback(async () => {
    try {
      setInitializing(true);
      setError(null);
      const token = getOrCreateSessionToken();
      sessionTokenRef.current = token;

      const res = await fetch("/api/chat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: token }),
      });

      const json = await res.json();

      if (!json.ok) {
        setError(json.error?.message ?? "Failed to start conversation");
        return;
      }

      setConversationId(json.data.conversation.id);

      // Fetch JWT for Realtime RLS (session_token-scoped). If 503, realtime is disabled.
      try {
        const tokenRes = await fetch("/api/chat/realtime-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_token: token }),
        });
        const tokenJson = await tokenRes.json();
        if (tokenJson.ok) {
          setRealtimeToken(tokenJson.data.token);
        }
      } catch {
        // Realtime disabled; chat still works via HTTP
      }

      const conv = json.data.conversation as { ai_enabled: boolean; status: string };
      if (!conv.ai_enabled || conv.status === 'waiting_human' || conv.status === 'human_active') {
        setIsHandedOff(true);
      }

      // `messages` is always present — history for resumes, greeting for new convos.
      // Map DB message roles to the display roles used by <ChatMessage>.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incoming = (json.data.messages as any[] ?? []).map((m: any) => ({
        id: m.id as string,
        role: (m.role === "patient" ? "user" : m.role === "human" ? "staff" : "assistant") as
          "user" | "assistant" | "staff",
        content: m.content as string,
        timestamp: getTime(),
      }));

      for (const m of incoming) {
        seenIdsRef.current.add(m.id);
      }
      if (incoming.length > 0) {
        setMessages(incoming);
      }
    } catch (err) {
      setError("Could not connect to the server. Please try again.");
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    startConversation();
  }, [startConversation]);

  // Clean up the confirmation auto-cancel timer on unmount.
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleNewConversation = useCallback(() => {
    if (!confirmNew) {
      // First click — ask for confirmation and auto-cancel after 3 s.
      setConfirmNew(true);
      confirmTimerRef.current = setTimeout(() => setConfirmNew(false), 3000);
      return;
    }
    // Guard: don't reset while a send is in-flight — the response callback
    // would append an AI message to the freshly cleared conversation.
    if (isTyping) return;
    // Second click — reset and start fresh.
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmNew(false);
    setMessages([]);
    setInput("");
    setIsTyping(false);
    setIsHandedOff(false);
    setError(null);
    setConversationId(null);
    setRealtimeToken(null);
    seenIdsRef.current = new Set();
    // Generate a new session token so the API creates a brand-new conversation.
    const newToken = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, newToken);
    sessionTokenRef.current = newToken;
    startConversation();
  }, [confirmNew, isTyping, startConversation]);

  // Realtime: receive staff replies and system notifications without page reload.
  // Processes `human` and `system` role inserts only — patient and AI messages
  // are handled via the HTTP response in sendMessage().
  useRealtimeMessages(conversationId, (newMsg) => {
    const role = newMsg.role as string;
    if (role !== 'human' && role !== 'system') return;
    const msgId = newMsg.id as string;
    if (seenIdsRef.current.has(msgId)) return;
    seenIdsRef.current.add(msgId);
    setMessages((prev) => [
      ...prev,
      {
        id: msgId,
        role: role === 'system' ? 'system' : 'staff',
        content: newMsg.content as string,
        timestamp: getTime(),
      },
    ]);
  }, realtimeToken);

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isTyping || !conversationId) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: getTime(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_token: sessionTokenRef.current,
          conversation_id: conversationId,
          content: trimmed,
        }),
      });

      const json = await res.json();

      if (!json.ok) {
        setError(json.error?.message ?? "Failed to send message");
        return;
      }

      const aiMsg: Message = {
        id: json.data.message.id,
        role: "assistant",
        content: json.data.message.content,
        timestamp: getTime(),
      };

      // Mark this AI message as seen so the realtime INSERT doesn't duplicate it
      seenIdsRef.current.add(json.data.message.id as string);
      setMessages((prev) => [...prev, aiMsg]);

      // Detect escalation: conversation is now waiting for a human agent
      const conv = json.data.conversation as { ai_enabled: boolean; status: string } | undefined;
      if (conv && (!conv.ai_enabled || conv.status === 'waiting_human')) {
        setIsHandedOff(true);
      }
    } catch (err) {
      setError("Connection error. Please try again.");
    } finally {
      setIsTyping(false);
    }
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden shadow-md">
      <CardHeader className="border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            AI
          </div>
          <div className="flex-1">
            <CardTitle className="text-sm font-semibold">
              {process.env.NEXT_PUBLIC_CLINIC_NAME ?? "Our Dental Practice"}
            </CardTitle>
            <CardDescription className="flex items-center gap-1.5 text-xs">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              AI Receptionist · Online
            </CardDescription>
          </div>
          {!initializing && messages.length > 0 && (
            <Button
              variant={confirmNew ? "destructive" : "ghost"}
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleNewConversation}
              title="Start a new conversation"
            >
              <RotateCcw className="size-3" />
              {confirmNew ? "Confirm?" : "New chat"}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto p-5">
        <div className="flex flex-col gap-4">
          {initializing && messages.length === 0 && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Starting conversation...
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
              <button
                className="ml-2 underline"
                onClick={() => {
                  setError(null);
                  if (!conversationId) startConversation();
                }}
              >
                Retry
              </button>
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}

          {isTyping && (
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
                AI
              </div>
              <div className="rounded-2xl rounded-tl-sm border border-border/60 bg-muted px-4 py-2.5">
                <span className="flex gap-1">
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </CardContent>

      {isHandedOff ? (
        <CardFooter className="border-t px-4 py-3">
          <div className="flex w-full items-center justify-center gap-2 rounded-md bg-amber-50 px-4 py-2.5 text-sm text-amber-700 border border-amber-200">
            <span className="size-2 animate-pulse rounded-full bg-amber-500" />
            A staff member will be with you shortly.
          </div>
        </CardFooter>
      ) : (
        <CardFooter className="border-t px-4 py-3">
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <Input
              className="h-10 flex-1 text-sm"
              placeholder="Type your message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isTyping || initializing || !conversationId}
              autoComplete="off"
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              className="size-10 shrink-0"
              disabled={!input.trim() || isTyping || !conversationId}
              aria-label="Send message"
            >
              <SendHorizonal className="size-4" />
            </Button>
          </form>
        </CardFooter>
      )}
    </Card>
  );
}
