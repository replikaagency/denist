"use client";

import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

type ScrollAreaProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    className?: string;
  }
>;

// Lightweight scroll container so we don't depend on a dedicated ScrollArea yet.
export function ScrollArea({ className, children, ...props }: ScrollAreaProps) {
  return (
    <div
      className={cn(
        "relative h-full w-full overflow-y-auto overscroll-y-contain scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-800/70",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

