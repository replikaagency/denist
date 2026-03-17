import { cn } from "@/lib/utils";

export type Message = {
  id: string;
  role: "user" | "assistant" | "staff" | "system";
  content: string;
  timestamp: string;
};

type ChatMessageProps = {
  message: Message;
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
} satisfies Record<Message["role"], { align: string; itemsAlign: string; avatarClass: string; avatarLabel: string; bubbleClass: string }>;

export function ChatMessage({ message }: ChatMessageProps) {
  // System messages render as a centered, divider-style notification
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
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
    <div className={cn("flex w-full gap-3", config.align)}>
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
        <div className={cn("rounded-2xl px-4 py-2.5 text-sm leading-relaxed", config.bubbleClass)}>
          {message.content}
        </div>
        <span className="px-1 text-[11px] text-muted-foreground">{message.timestamp}</span>
      </div>
    </div>
  );
}
