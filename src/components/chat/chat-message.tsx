"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type Message = {
  id: string;
  role: "user" | "assistant" | "staff" | "system";
  content: string;
  timestamp: string;
  /** Fade/slide-in for newly appended messages (skip for history on load). */
  animateEnter?: boolean;
  /** Light progressive reveal for assistant text (UI-only). */
  streamReveal?: boolean;
};

type ChatMessageProps = {
  message: Message;
  /** Skip motion/streaming when user prefers reduced motion. */
  reduceMotion?: boolean;
};

const ROLE_CONFIG = {
  user: {
    align: "flex-row-reverse",
    itemsAlign: "items-end",
    avatarClass: "bg-primary text-primary-foreground",
    avatarLabel: "P",
    bubbleClass: "rounded-tr-sm bg-primary text-primary-foreground",
  },
  assistant: {
    align: "flex-row",
    itemsAlign: "items-start",
    avatarClass: "bg-muted text-muted-foreground border border-border",
    avatarLabel: "AI",
    bubbleClass: "rounded-tl-sm bg-muted text-foreground border border-border/60",
  },
  staff: {
    align: "flex-row",
    itemsAlign: "items-start",
    avatarClass: "bg-emerald-100 text-emerald-800 border border-emerald-200",
    avatarLabel: "ST",
    bubbleClass: "rounded-tl-sm bg-emerald-50 text-foreground border border-emerald-200",
  },
  // system is handled by its own render branch below — these are fallback values
  system: {
    align: "flex-row",
    itemsAlign: "items-center",
    avatarClass: "",
    avatarLabel: "",
    bubbleClass: "",
  },
} satisfies Record<
  Message["role"],
  { align: string; itemsAlign: string; avatarClass: string; avatarLabel: string; bubbleClass: string }
>;

const enterMotion = "animate-in fade-in slide-in-from-bottom-1 duration-200 fill-mode-both";

function AssistantStreamText({
  text,
  enabled,
  instant,
}: {
  text: string;
  enabled: boolean;
  instant?: boolean;
}) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!enabled || instant) return;
    const step = 4;
    const tickMs = 16;
    let i = 0;
    const id = window.setInterval(() => {
      i += step;
      if (i >= text.length) {
        setShown(text.length);
        window.clearInterval(id);
      } else {
        setShown(i);
      }
    }, tickMs);
    return () => window.clearInterval(id);
  }, [text, enabled, instant]);

  if (!enabled || instant) return <>{text}</>;
  return <>{text.slice(0, shown)}</>;
}

export function ChatMessage({ message, reduceMotion }: ChatMessageProps) {
  // System messages render as a centered, divider-style notification
  if (message.role === "system") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 py-1",
          message.animateEnter && !reduceMotion && enterMotion,
        )}
      >
        <div className="h-px flex-1 bg-border/60" />
        <span className="shrink-0 text-[11px] italic text-muted-foreground">
          {message.content}
        </span>
        <div className="h-px flex-1 bg-border/60" />
      </div>
    );
  }

  const config = ROLE_CONFIG[message.role];

  return (
    <div
      className={cn(
        "flex w-full gap-3",
        config.align,
        message.animateEnter && !reduceMotion && enterMotion,
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          config.avatarClass,
        )}
        aria-hidden="true"
      >
        {config.avatarLabel}
      </div>

      <div className={cn("flex max-w-[75%] flex-col gap-1", config.itemsAlign)}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            config.bubbleClass,
          )}
        >
          {message.role === "assistant" && message.streamReveal ? (
            <AssistantStreamText
              text={message.content}
              enabled
              instant={reduceMotion}
            />
          ) : (
            message.content
          )}
        </div>
        <span className="px-1 text-[11px] text-muted-foreground">{message.timestamp}</span>
      </div>
    </div>
  );
}
