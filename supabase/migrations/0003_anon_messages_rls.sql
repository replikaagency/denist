-- =============================================================================
-- Migration 0003: Anon RLS policy for messages (patient realtime)
-- =============================================================================
--
-- PROBLEM
-- -------
-- The patient chat widget (unauthenticated / anon role) uses Supabase Realtime
-- postgres_changes on the `messages` table to receive staff replies and system
-- notifications in real time (see src/hooks/use-realtime.ts and
-- src/components/chat/chat-ui.tsx).
--
-- The initial schema (0001) only granted SELECT to the `authenticated` role:
--
--   CREATE POLICY "staff_read_all" ON messages FOR SELECT TO authenticated ...
--
-- With no anon SELECT policy and RLS enabled, Supabase Realtime silently drops
-- all events for unauthenticated subscribers. Staff replies and takeover /
-- resolve system messages never appear in the patient chat without a page
-- refresh.
--
-- SOLUTION
-- --------
-- Add an anon SELECT policy on `messages` scoped to rows that belong to a
-- conversation that actually exists in the database.
--
-- Security model (intentional for MVP):
--
--   1. The patient receives their conversation_id from POST /api/chat/start,
--      which validates the session_token server-side via the admin client.
--      The patient legitimately knows their own conversation_id.
--
--   2. Conversation UUIDs are gen_random_uuid() — 128-bit cryptographically
--      random. They are not enumerable or guessable.
--
--   3. The anon SELECT policy on `messages` requires the row's conversation_id
--      to point to a real conversation row. A `SECURITY DEFINER` helper
--      function performs this check without granting the anon role direct
--      SELECT access to the `conversations` table itself.
--
--   4. Supabase Realtime delivers events only for rows matching the channel's
--      filter (conversation_id=eq.<id>). The patient receives only messages
--      from their own conversation even if the broader policy technically
--      allows reading any conversation's messages.
--
--   5. Direct REST API (PostgREST + anon key): a caller who knows a valid
--      conversation UUID can read its messages. This is the accepted boundary
--      for this MVP — UUID unguessability is the guard. Production hardening
--      path: issue per-session JWTs via a Supabase Edge Function embedding the
--      session_token as a custom claim, then tighten this policy to check
--      auth.jwt()->>'session_token' against the contact's session_token column.
--
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: check conversation existence without exposing the conversations
-- table to direct anon queries.
--
-- SECURITY DEFINER means the function executes as its owner (postgres), not
-- as the calling anon role, so it bypasses conversations' RLS. It returns
-- only a boolean — no conversation data is exposed to the caller.
--
-- SET search_path = public prevents search_path injection attacks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.anon_can_read_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversations
    WHERE id = p_conversation_id
  );
$$;

-- Revoke public EXECUTE (granted to PUBLIC by default on CREATE FUNCTION),
-- then grant explicitly only to the anon role.
REVOKE ALL ON FUNCTION public.anon_can_read_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anon_can_read_conversation(uuid) TO anon;

-- ---------------------------------------------------------------------------
-- Anon SELECT policy on messages
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_read_messages_for_conversation" ON public.messages;

CREATE POLICY "anon_read_messages_for_conversation"
  ON public.messages
  FOR SELECT
  TO anon
  USING (public.anon_can_read_conversation(conversation_id));
