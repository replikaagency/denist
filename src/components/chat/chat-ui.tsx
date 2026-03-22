"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, SendHorizonal, RotateCcw } from "lucide-react";
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

/**
 * UI-only pacing before showing the assistant bubble (not API latency).
 * Short replies feel snappier; long replies get a slightly longer “typing” beat.
 * Zero when prefers-reduced-motion (no artificial wait).
 */
function computeAssistantRevealDelayMs(content: string, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const len = content.length;
  if (len <= 40) {
    return Math.min(380, 220 + len * 3);
  }
  const scaled = 360 + Math.min(len, 220) * 2.6;
  return Math.min(900, Math.max(400, Math.round(scaled)));
}

export function ChatUI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [httpPending, setHttpPending] = useState(false);
  const [canShowTypingAfterUser, setCanShowTypingAfterUser] = useState(false);
  const [awaitingReveal, setAwaitingReveal] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [conversationStatus, setConversationStatus] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  // True once the conversation has been handed off to a human agent (disables input).
  const [isHandedOff, setIsHandedOff] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionTokenRef = useRef("");
  const seenIdsRef = useRef<Set<string>>(new Set());
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRevealMsgRef = useRef<Message | null>(null);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mq.matches);
    const onChange = () => setPrefersReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isChatBusy = httpPending || awaitingReveal;
  const showTypingIndicator =
    (httpPending && canShowTypingAfterUser) || awaitingReveal;

  const showHandoffNotify =
    conversationId != null &&
    !initializing &&
    (conversationStatus === "waiting_human" ||
      (aiEnabled === false && conversationStatus !== "human_active"));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [messages, showTypingIndicator, showHandoffNotify, prefersReducedMotion]);

  useEffect(() => {
    if (!httpPending) {
      setCanShowTypingAfterUser(false);
      return;
    }
    setCanShowTypingAfterUser(false);
    const t = setTimeout(() => setCanShowTypingAfterUser(true), 130);
    return () => clearTimeout(t);
  }, [httpPending]);

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);

  const flushPendingReveal = useCallback(() => {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    const pending = pendingRevealMsgRef.current;
    if (!pending) return;
    pendingRevealMsgRef.current = null;
    setAwaitingReveal(false);
    setMessages((prev) => [...prev, pending]);
  }, []);

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
      setConversationStatus(conv.status);
      setAiEnabled(conv.ai_enabled);
      if (!conv.ai_enabled || conv.status === "waiting_human" || conv.status === "human_active") {
        setIsHandedOff(true);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incoming = (json.data.messages as any[] ?? []).map((m: any) => ({
        id: m.id as string,
        role: (m.role === "patient" ? "user" : m.role === "human" ? "staff" : "assistant") as
          | "user"
          | "assistant"
          | "staff",
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
      setError("No se ha podido conectar. Por favor, inténtalo de nuevo.");
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    startConversation();
  }, [startConversation]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleNewConversation = useCallback(() => {
    if (!confirmNew) {
      setConfirmNew(true);
      confirmTimerRef.current = setTimeout(() => setConfirmNew(false), 3000);
      return;
    }
    if (isChatBusy) return;
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmNew(false);
    setMessages([]);
    setInput("");
    setHttpPending(false);
    setAwaitingReveal(false);
    setCanShowTypingAfterUser(false);
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    pendingRevealMsgRef.current = null;
    setIsHandedOff(false);
    setError(null);
    setConversationId(null);
    setConversationStatus(null);
    setAiEnabled(null);
    setRealtimeToken(null);
    seenIdsRef.current = new Set();
    const newToken = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, newToken);
    sessionTokenRef.current = newToken;
    startConversation();
  }, [confirmNew, isChatBusy, startConversation]);

  useRealtimeMessages(conversationId, (newMsg) => {
    const role = newMsg.role as string;
    if (role !== "human" && role !== "system") return;
    const msgId = newMsg.id as string;
    if (seenIdsRef.current.has(msgId)) return;
    // Preserve order: if an AI reply is still “in the wings”, show it before staff/system.
    flushPendingReveal();
    seenIdsRef.current.add(msgId);
    setMessages((prev) => [
      ...prev,
      {
        id: msgId,
        role: role === "system" ? "system" : "staff",
        content: newMsg.content as string,
        timestamp: getTime(),
        animateEnter: role !== "system",
      },
    ]);
  }, realtimeToken);

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isChatBusy || !conversationId) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: getTime(),
      animateEnter: true,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setHttpPending(true);
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
        setError(json.error?.message ?? "No se ha podido enviar el mensaje");
        setHttpPending(false);
        pendingRevealMsgRef.current = null;
        return;
      }

      const aiMsg: Message = {
        id: json.data.message.id,
        role: "assistant",
        content: json.data.message.content,
        timestamp: getTime(),
        animateEnter: true,
        streamReveal: true,
      };

      seenIdsRef.current.add(json.data.message.id as string);

      const conv = json.data.conversation as { ai_enabled: boolean; status: string } | undefined;
      if (conv) {
        setConversationStatus(conv.status);
        setAiEnabled(conv.ai_enabled);
        if (!conv.ai_enabled || conv.status === "waiting_human") {
          setIsHandedOff(true);
        }
      }

      const delayMs = computeAssistantRevealDelayMs(aiMsg.content, prefersReducedMotion);
      pendingRevealMsgRef.current = aiMsg;
      setHttpPending(false);

      if (delayMs === 0) {
        pendingRevealMsgRef.current = null;
        setMessages((prev) => [...prev, aiMsg]);
        setAwaitingReveal(false);
      } else {
        setAwaitingReveal(true);
        if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
        revealTimerRef.current = setTimeout(() => {
          revealTimerRef.current = null;
          pendingRevealMsgRef.current = null;
          setMessages((prev) => [...prev, aiMsg]);
          setAwaitingReveal(false);
        }, delayMs);
      }
    } catch (err) {
      setError("Error de conexión. Por favor, inténtalo de nuevo.");
      setHttpPending(false);
      setAwaitingReveal(false);
      pendingRevealMsgRef.current = null;
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
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
              {process.env.NEXT_PUBLIC_CLINIC_NAME ?? "Clínica Dental"}
            </CardTitle>
            <CardDescription className="flex items-center gap-1.5 text-xs">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Recepcionista · En línea
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
              {confirmNew ? "¿Confirmar?" : "Nueva conversación"}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto p-5">
        <div className="flex flex-col gap-4">
          {initializing && messages.length === 0 && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Iniciando conversación...
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
                Reintentar
              </button>
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} reduceMotion={prefersReducedMotion} />
          ))}

          {showHandoffNotify && (
            <div
              className="flex items-center gap-2.5 rounded-xl border border-amber-200/80 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-900 shadow-sm animate-in fade-in slide-in-from-bottom-1 duration-200"
              role="status"
              aria-live="polite"
            >
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-amber-700 motion-reduce:animate-none"
                aria-hidden
              />
              <span className="leading-snug">Notificando al equipo…</span>
            </div>
          )}

          {showTypingIndicator && (
            <div
              className="flex items-center gap-3 animate-in fade-in duration-150"
              role="status"
              aria-label="La asistente está escribiendo"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
                AI
              </div>
              <div className="rounded-2xl rounded-tl-sm border border-border/60 bg-muted px-4 py-2.5">
                <span className="flex gap-1 motion-reduce:animate-none" aria-hidden>
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms] motion-reduce:animate-none" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms] motion-reduce:animate-none" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms] motion-reduce:animate-none" />
                </span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </CardContent>

      {isHandedOff ? (
        <CardFooter className="border-t px-4 py-3">
          <div
            className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700"
            role="status"
            aria-live="polite"
          >
            <span className="size-2 animate-pulse rounded-full bg-amber-500 motion-reduce:animate-none" />
            Un miembro del equipo te atenderá en breve.
          </div>
        </CardFooter>
      ) : (
        <CardFooter className="border-t px-4 py-3">
          <form
            className="flex w-full items-center gap-2"
            aria-busy={isChatBusy}
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <Input
              className="h-10 flex-1 text-sm"
              placeholder="Escribe tu mensaje..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isChatBusy || initializing || !conversationId}
              autoComplete="off"
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              className="size-10 shrink-0"
              disabled={!input.trim() || isChatBusy || !conversationId}
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
