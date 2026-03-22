'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Send, UserCheck, CheckCircle } from 'lucide-react';
import { useRealtimeMessages, useRealtimeTable } from '@/hooks/use-realtime';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  waiting_human: 'bg-amber-100 text-amber-800',
  human_active: 'bg-blue-100 text-blue-800',
  resolved: 'bg-gray-100 text-gray-600',
  abandoned: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'IA activa',
  waiting_human: 'Requiere atención',
  human_active: 'Atendida por persona',
  resolved: 'Cerrada',
  abandoned: 'Abandonada',
};

const ROLE_STYLES: Record<string, { label: string; bg: string; container: string }> = {
  patient: { label: 'Paciente', bg: 'bg-blue-50 border-blue-200', container: 'justify-end' },
  ai: { label: 'IA', bg: 'bg-muted border-border', container: 'justify-start' },
  human: { label: 'Equipo', bg: 'bg-emerald-50 border-emerald-200', container: 'justify-start' },
  system: { label: 'Sistema', bg: 'bg-yellow-50 border-yellow-200', container: 'justify-center' },
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('es-ES', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ConversationDetail({
  conversation,
  messages: initialMessages,
  handoff,
}: {
  conversation: Record<string, unknown>;
  messages: Record<string, unknown>[];
  handoff: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(conversation.status as string);

  const contact = conversation.contact as Record<string, unknown> | null;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') ||
      (contact.email as string) ||
      (contact.phone as string) ||
      'Sin nombre'
    : 'Desconocido';

  const canReply = status === 'waiting_human' || status === 'human_active';
  const canTakeover = status === 'waiting_human';
  const canResolve = status !== 'resolved' && status !== 'abandoned';

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Realtime: sync conversation status when another staff member takes over /
  // resolves the conversation so action buttons stay accurate.
  useRealtimeTable(
    'conversations',
    (payload) => {
      if (payload.eventType === 'UPDATE') {
        const newStatus = payload.new.status as string | undefined;
        if (newStatus && newStatus !== status) {
          setStatus(newStatus);
        }
      }
    },
    { filter: `id=eq.${conversation.id as string}` },
  );

  // Realtime: listen for new messages in this conversation
  const seenIdsRef = useRef(new Set(initialMessages.map((m) => m.id as string)));
  useRealtimeMessages(
    conversation.id as string,
    (newMsg) => {
      const msgId = newMsg.id as string;
      if (!seenIdsRef.current.has(msgId)) {
        seenIdsRef.current.add(msgId);
        setMessages((prev) => [...prev, newMsg]);
      }
    },
  );

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleTakeover() {
    const res = await fetch(`/api/conversations/${conversation.id}/takeover`, {
      method: 'POST',
    });
    if (res.ok) {
      setStatus('human_active');
      router.refresh();
    }
  }

  async function handleResolve() {
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    if (res.ok) {
      setStatus('resolved');
      const json = await res.json();
      if (json.ok && json.data?.systemMessage) {
        const sm = json.data.systemMessage as Record<string, unknown>;
        seenIdsRef.current.add(sm.id as string);
        setMessages((prev) => [...prev, sm]);
      }
      router.refresh();
    }
  }

  async function handleSendReply() {
    if (!replyText.trim() || sending) return;
    setSending(true);

    try {
      const res = await fetch(`/api/conversations/${conversation.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyText.trim() }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json.ok) {
          // On auto-claim the server returns a system message before the staff
          // reply. Add it first so the join notification appears in the correct
          // chronological position (before the first staff message).
          if (json.data?.systemMessage) {
            const sm = json.data.systemMessage as Record<string, unknown>;
            seenIdsRef.current.add(sm.id as string);
            setMessages((prev) => [...prev, sm]);
          }
          if (json.data?.message) {
            seenIdsRef.current.add(json.data.message.id as string);
            setMessages((prev) => [...prev, json.data.message]);
          }
        }
        setReplyText('');
        if (status === 'waiting_human') {
          setStatus('human_active');
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/dashboard">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="size-3.5" />
            Volver
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{contactName}</h1>
            <Badge variant="outline" className={STATUS_COLORS[status] ?? ''}>
              {STATUS_LABELS[status] ?? status}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            {contact?.email as string ?? ''} {contact?.phone ? `· ${contact.phone}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          {canTakeover && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleTakeover}>
              <UserCheck className="size-3.5" />
              Tomar conversación
            </Button>
          )}
          {canResolve && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleResolve}>
              <CheckCircle className="size-3.5" />
              Cerrar conversación
            </Button>
          )}
        </div>
      </div>

      {/* Contact info card */}
      {contact && (
        <Card>
          <CardHeader className="py-3 px-5">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Datos de contacto
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4 pt-0">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
              {contact.first_name ? (
                <div>
                  <span className="text-muted-foreground">Nombre: </span>
                  {String(contact.first_name)} {contact.last_name ? String(contact.last_name) : ''}
                </div>
              ) : null}
              {contact.email ? (
                <div>
                  <span className="text-muted-foreground">Correo: </span>
                  {String(contact.email)}
                </div>
              ) : null}
              {contact.phone ? (
                <div>
                  <span className="text-muted-foreground">Teléfono: </span>
                  {String(contact.phone)}
                </div>
              ) : null}
              {contact.insurance_provider ? (
                <div>
                  <span className="text-muted-foreground">Seguro: </span>
                  {String(contact.insurance_provider)}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Handoff info */}
      {handoff && !(handoff.resolved_at) && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="px-5 py-3">
            <div className="text-sm">
              <span className="font-medium text-amber-800">Motivo de derivación: </span>
              <span className="text-amber-700">
                {handoff.reason as string}
                {handoff.notes ? ` — ${handoff.notes}` : ''}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Messages */}
      <Card>
        <CardContent className="p-5">
          <div className="space-y-3">
            {messages.map((msg) => {
              const role = msg.role as string;
              const style = ROLE_STYLES[role] ?? ROLE_STYLES.system;

              return (
                <div key={msg.id as string} className={`flex ${style.container}`}>
                  <div
                    className={`max-w-[75%] rounded-lg border px-3 py-2 ${style.bg}`}
                  >
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {style.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTime(msg.created_at as string)}
                      </span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap">{msg.content as string}</div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* Reply box */}
      {canReply && (
        <Card>
          <CardContent className="p-4">
            <div className="flex gap-2">
              <Textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Escriba su respuesta al paciente…"
                className="min-h-[80px] flex-1 text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleSendReply();
                  }
                }}
              />
              <Button
                size="icon"
                className="mt-auto size-10 shrink-0"
                disabled={!replyText.trim() || sending}
                onClick={handleSendReply}
              >
                <Send className="size-4" />
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              ⌘ Cmd / Ctrl + Intro para enviar
              {canTakeover && (
                <span className="ml-2 text-amber-600">
                  · Al enviar una respuesta se asignará esta conversación a usted.
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
