'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRealtimeConversations } from '@/hooks/use-realtime';

interface ConversationRow {
  id: string;
  status: string;
  channel: string;
  ai_enabled: boolean;
  last_message_at: string | null;
  created_at: string;
  last_message_preview: string | null;
  last_message_role: string | null;
  contact: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  waiting_human: 'bg-amber-100 text-amber-800',
  human_active: 'bg-blue-100 text-blue-800',
  resolved: 'bg-gray-100 text-gray-600',
  abandoned: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'AI Active',
  waiting_human: 'Needs Attention',
  human_active: 'Staff Active',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
};

const CHANNEL_LABELS: Record<string, string> = {
  web_chat: 'Web Chat',
  web: 'Web Chat',
  sms: 'SMS',
  email: 'Email',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
};

function formatTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

function contactName(contact: ConversationRow['contact']) {
  if (!contact) return 'Unknown';
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  return name || contact.email || contact.phone || 'Anonymous';
}

export function ConversationsList({
  conversations,
  total,
  currentStatus,
  statusCounts,
}: {
  conversations: ConversationRow[];
  total: number;
  currentStatus?: string;
  statusCounts: Record<string, number>;
}) {
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  // Realtime: refresh the list when any conversation changes.
  // Debounced to 300 ms so a burst of rapid events triggers only one refresh.
  useRealtimeConversations(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 300);
  });

  const STATUSES = ['all', 'active', 'waiting_human', 'human_active', 'resolved', 'abandoned'];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {STATUSES.map((s) => {
          const isActive = s === 'all' ? !currentStatus : currentStatus === s;
          const count = s === 'all'
            ? Object.values(statusCounts).reduce((a, b) => a + b, 0)
            : statusCounts[s] ?? 0;

          return (
            <Button
              key={s}
              variant={isActive ? 'secondary' : 'outline'}
              size="sm"
              className="text-xs"
              onClick={() => {
                const url = s === 'all' ? '/dashboard' : `/dashboard?status=${s}`;
                router.push(url);
              }}
            >
              {s === 'all' ? 'All' : STATUS_LABELS[s] ?? s}
              <span className="ml-1.5 text-muted-foreground">({count})</span>
            </Button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="py-3 px-5">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {total} conversation{total !== 1 ? 's' : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {conversations.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {currentStatus
                ? `No ${(STATUS_LABELS[currentStatus] ?? currentStatus).toLowerCase()} conversations.`
                : 'No conversations yet.'}
            </div>
          ) : (
            <div className="divide-y">
              {conversations.map((conv) => (
                <Link
                  key={conv.id}
                  href={`/dashboard/conversations/${conv.id}`}
                  className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {contactName(conv.contact)}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${STATUS_COLORS[conv.status] ?? ''}`}
                      >
                        {STATUS_LABELS[conv.status] ?? conv.status}
                      </Badge>
                      {!conv.ai_enabled
                        && conv.status !== 'resolved'
                        && conv.status !== 'abandoned'
                        && conv.status !== 'waiting_human'
                        && conv.status !== 'human_active' && (
                        <Badge variant="outline" className="text-[10px] bg-orange-50 text-orange-700 border-orange-200">
                          AI Paused
                        </Badge>
                      )}
                    </div>
                    {conv.last_message_preview ? (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        <span className="font-medium capitalize">{conv.last_message_role === 'patient' ? 'Patient' : conv.last_message_role === 'human' ? 'Staff' : 'AI'}:</span>{' '}
                        {conv.last_message_preview.length > 80
                          ? conv.last_message_preview.slice(0, 80) + '…'
                          : conv.last_message_preview}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {CHANNEL_LABELS[conv.channel] ?? conv.channel} · {conv.contact?.email || conv.contact?.phone || 'No contact info'}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatTime(conv.last_message_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
