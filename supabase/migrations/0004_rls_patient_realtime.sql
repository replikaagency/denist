-- =============================================================================
-- Migration 0004: Tighten anon messages RLS to session_token + fix realtime
-- =============================================================================
--
-- AUDIT FINDINGS
-- --------------
-- 1. Migration 0003 added `anon_read_messages_for_conversation` on `messages`
--    but its USING clause only checked that the conversation UUID exists in the
--    conversations table.  Any anon caller who knows a valid conversation_id
--    can read all messages in that conversation — UUID unguessability was the
--    only guard.
--
-- 2. The supabase_realtime publication was added only in
--    0001_initial_schema_idempotent.sql.  Projects set up with the original
--    0001_initial_schema.sql + 0003_anon_messages_rls.sql never had
--    `messages` or `conversations` added to the publication, so Realtime
--    events were silently dropped.
--
-- FIX
-- ---
-- Replace the UUID-only anon policy with a session_token ownership policy.
-- The anon role must present a JWT containing a `session_token` claim that
-- matches the session_token column on the contact linked to the conversation.
--
-- How the JWT reaches the browser:
--   1. POST /api/chat/realtime-token validates the session_token server-side
--      and returns a 1-hour JWT signed with SUPABASE_JWT_SECRET.
--   2. The chat widget calls supabase.realtime.setAuth(token) before
--      subscribing to postgres_changes.
--   3. Supabase Realtime attaches the JWT to the WebSocket handshake and
--      per-event RLS checks.
--   4. auth.jwt() ->> 'session_token' in the USING clause returns the claim.
--
-- Security properties:
--   - An anon caller with no JWT, or a JWT without session_token, is denied.
--   - A caller with a valid session_token can only read messages in
--     conversations owned by that session_token's contact.
--   - Tokens are short-lived (1 hour) and server-signed — not forgeable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New SECURITY DEFINER helper: verify JWT session_token owns conversation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.anon_owns_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = p_conversation_id
      AND ct.session_token = (auth.jwt() ->> 'session_token')
  );
$$;

REVOKE ALL ON FUNCTION public.anon_owns_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anon_owns_conversation(uuid) TO anon;

-- ---------------------------------------------------------------------------
-- 2. Replace the old weak policy with the session_token-scoped policy
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_read_messages_for_conversation" ON public.messages;

CREATE POLICY "anon_read_own_messages"
  ON public.messages
  FOR SELECT
  TO anon
  USING (public.anon_owns_conversation(conversation_id));

-- The old UUID-only helper is superseded; drop it to avoid confusion.
-- (The policy referencing it has already been dropped above.)
DROP FUNCTION IF EXISTS public.anon_can_read_conversation(uuid);

-- ---------------------------------------------------------------------------
-- 3. Ensure messages + conversations are in the supabase_realtime publication
--    (idempotent — DO blocks swallow "already a member" errors)
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
