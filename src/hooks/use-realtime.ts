'use client';

import { useEffect, useRef } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Subscribe to Supabase Realtime changes on a table.
 * Calls `onPayload` for every INSERT, UPDATE, or DELETE event.
 */
export function useRealtimeTable(
  table: string,
  onPayload: (payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Record<string, unknown>;
    old: Record<string, unknown>;
  }) => void,
  options?: {
    filter?: string;
    enabled?: boolean;
  },
) {
  const callbackRef = useRef(onPayload);
  callbackRef.current = onPayload;

  useEffect(() => {
    if (options?.enabled === false) return;

    const supabase = createSupabaseBrowserClient();
    let channel: RealtimeChannel;

    const channelName = `realtime-${table}-${Date.now()}`;

    channel = supabase.channel(channelName);

    const subscribeConfig: {
      event: '*';
      schema: 'public';
      table: string;
      filter?: string;
    } = {
      event: '*',
      schema: 'public',
      table,
    };

    if (options?.filter) {
      subscribeConfig.filter = options.filter;
    }

    channel
      .on(
        'postgres_changes',
        subscribeConfig,
        (payload) => {
          callbackRef.current({
            eventType: payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE',
            new: (payload.new ?? {}) as Record<string, unknown>,
            old: (payload.old ?? {}) as Record<string, unknown>,
          });
        },
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error(`[realtime] ${channelName} — ${status}`, err ?? '');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table, options?.filter, options?.enabled]);
}

/**
 * Subscribe to new messages in a specific conversation.
 *
 * For patient chat (anon): pass `realtimeToken` from POST /api/chat/realtime-token.
 * RLS requires the JWT to contain session_token; without it, events are dropped.
 *
 * For staff (authenticated): token is optional; the default anon/authenticated
 * key is used and staff policies apply.
 */
export function useRealtimeMessages(
  conversationId: string | null,
  onNewMessage: (message: Record<string, unknown>) => void,
  realtimeToken?: string | null,
) {
  const callbackRef = useRef(onNewMessage);
  callbackRef.current = onNewMessage;

  // Set custom JWT for Realtime before subscribing (patient chat flow).
  // Must run before the subscription effect.
  useEffect(() => {
    if (!realtimeToken) return;
    const supabase = createSupabaseBrowserClient();
    supabase.realtime.setAuth(realtimeToken);
  }, [realtimeToken]);

  useRealtimeTable(
    'messages',
    (payload) => {
      if (payload.eventType === 'INSERT') {
        callbackRef.current(payload.new);
      }
    },
    {
      filter: conversationId ? `conversation_id=eq.${conversationId}` : undefined,
      // Patient: require token for RLS. Staff: token not passed (uses auth session).
      enabled: !!conversationId && (realtimeToken === undefined ? true : !!realtimeToken),
    },
  );
}

/**
 * Subscribe to conversation status changes.
 */
export function useRealtimeConversations(
  onUpdate: (payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Record<string, unknown>;
    old: Record<string, unknown>;
  }) => void,
) {
  useRealtimeTable('conversations', onUpdate);
}
