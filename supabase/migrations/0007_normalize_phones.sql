-- ---------------------------------------------------------------------------
-- 0007_normalize_phones.sql
-- Normalize all existing phone numbers in contacts to E.164 format (+34XXXXXXXXX).
--
-- Patterns handled:
--   "0034XXXXXXXXX" (13 digits, international exit code)  → "+34XXXXXXXXX"
--   "34XXXXXXXXX"   (11 digits, country code, no prefix)  → "+34XXXXXXXXX"
--   "XXXXXXXXX"     (9 digits, bare Spanish number)        → "+34XXXXXXXXX"
--
-- Rows that don't match any pattern are left unchanged to avoid corrupting
-- international or unrecognizable numbers.
--
-- Run the verification query at the bottom AFTER applying to confirm no
-- duplicates were introduced.
-- ---------------------------------------------------------------------------

UPDATE public.contacts
SET phone = CASE
  -- "0034XXXXXXXXX" — 13 digits starting with 0034
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0034[0-9]{9}$'
    THEN '+' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 3)

  -- "34XXXXXXXXX" — 11 digits with country code, no prefix
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^34[6-9][0-9]{8}$'
    THEN '+' || regexp_replace(phone, '[^0-9]', '', 'g')

  -- "XXXXXXXXX" — 9-digit bare Spanish number (mobile: 6xx/7xx, landline: 8xx/9xx)
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^[6-9][0-9]{8}$'
    THEN '+34' || regexp_replace(phone, '[^0-9]', '', 'g')

  -- Already normalized or unrecognizable — leave unchanged
  ELSE phone
END
WHERE phone IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Verification: run this after applying the migration.
-- Must return zero rows before the deployment proceeds.
-- ---------------------------------------------------------------------------
-- SELECT phone, count(*) AS n
-- FROM public.contacts
-- WHERE phone IS NOT NULL
-- GROUP BY phone
-- HAVING count(*) > 1;
