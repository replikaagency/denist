-- ---------------------------------------------------------------------------
-- 0008_normalize_emails.sql
-- Normalize all existing email addresses in contacts to lowercase + trimmed.
--
-- Mirrors the application-layer normalization added in the identity hardening
-- batch: every email write now calls email.toLowerCase().trim() before hitting
-- the DB.  Without this migration the existing UNIQUE(email) constraint cannot
-- catch mixed-case duplicates that were stored before the code change.
--
-- Safe: only modifies rows where the stored value differs from its normalized
-- form.  Rows already normalized are untouched.
--
-- IMPORTANT: run the verification query below BEFORE deploying the code change
-- to confirm no duplicate emails exist after normalization.  If it returns rows,
-- merge those contacts manually first.
-- ---------------------------------------------------------------------------

UPDATE public.contacts
SET email = lower(trim(email))
WHERE email IS NOT NULL
  AND email <> lower(trim(email));

-- ---------------------------------------------------------------------------
-- Verification — must return zero rows before the code deployment proceeds.
-- ---------------------------------------------------------------------------
-- SELECT email, count(*) AS n
-- FROM public.contacts
-- WHERE email IS NOT NULL
-- GROUP BY email
-- HAVING count(*) > 1;
