"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ChatMessage, type Message } from "@/components/chat/chat-message";

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
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionTokenRef = useRef("");

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

      if (json.data.greeting) {
        setMessages([{
          id: json.data.greeting.id,
          role: "assistant",
          content: json.data.greeting.content,
          timestamp: getTime(),
        }]);
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

      setMessages((prev) => [...prev, aiMsg]);
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
          <div>
            <CardTitle className="text-sm font-semibold">Bright Smile Dental</CardTitle>
            <CardDescription className="flex items-center gap-1.5 text-xs">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              AI Receptionist · Online
            </CardDescription>
          </div>
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
    </Card>
  );
}
