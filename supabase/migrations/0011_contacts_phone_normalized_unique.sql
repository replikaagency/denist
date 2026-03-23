-- ---------------------------------------------------------------------------
-- 0011_contacts_phone_normalized_unique.sql
-- Enforce DB-level uniqueness for canonical phone values.
--
-- Goals:
-- 1) Add canonical phone field: contacts.phone_normalized
-- 2) Normalize on every write via trigger
-- 3) Resolve pre-existing collisions safely (without deleting contacts)
-- 4) Add unique index on phone_normalized where not null
-- ---------------------------------------------------------------------------

-- Canonical normalizer (Spanish E.164 where recognizable, else null).
create or replace function public.normalize_phone_e164(raw text)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
begin
  if raw is null then
    return null;
  end if;

  digits := regexp_replace(raw, '[^0-9]', '', 'g');
  if digits = '' then
    return null;
  end if;

  -- 0034XXXXXXXXX -> +34XXXXXXXXX
  if digits ~ '^0034[0-9]{9}$' then
    return '+' || substr(digits, 3);
  end if;

  -- 34XXXXXXXXX (Spain CC already present) -> +34XXXXXXXXX
  if digits ~ '^34[6-9][0-9]{8}$' then
    return '+' || digits;
  end if;

  -- Bare Spanish 9-digit -> +34XXXXXXXXX
  if digits ~ '^[6-9][0-9]{8}$' then
    return '+34' || digits;
  end if;

  -- Unknown format: keep out of unique scope for safety.
  return null;
end;
$$;

alter table public.contacts
  add column if not exists phone_normalized text;

-- Backfill canonical field from existing phone values.
update public.contacts
set phone_normalized = public.normalize_phone_e164(phone)
where phone is not null;

-- If multiple contacts collapse to the same canonical phone:
-- keep canonical on oldest row; clear canonical on others and annotate metadata.
with ranked as (
  select
    c.id,
    c.phone_normalized,
    first_value(c.id) over (
      partition by c.phone_normalized
      order by c.created_at asc, c.id asc
    ) as canonical_id,
    row_number() over (
      partition by c.phone_normalized
      order by c.created_at asc, c.id asc
    ) as rn
  from public.contacts c
  where c.phone_normalized is not null
),
conflicts as (
  select id, canonical_id
  from ranked
  where rn > 1
)
update public.contacts c
set
  phone_normalized = null,
  metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object(
    'phone_conflict',
    jsonb_build_object(
      'duplicate_of', conflicts.canonical_id,
      'resolved_at', now()
    )
  )
from conflicts
where c.id = conflicts.id;

create or replace function public.contacts_set_phone_normalized()
returns trigger
language plpgsql
as $$
begin
  if new.phone is null then
    new.phone_normalized := null;
  else
    new.phone_normalized := public.normalize_phone_e164(new.phone);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contacts_phone_normalized on public.contacts;
create trigger trg_contacts_phone_normalized
before insert or update of phone on public.contacts
for each row
execute function public.contacts_set_phone_normalized();

-- Query performance for canonical lookups.
create index if not exists idx_contacts_phone_normalized
  on public.contacts (phone_normalized)
  where phone_normalized is not null;

-- DB-level uniqueness guarantee for canonical phones.
create unique index if not exists uq_contacts_phone_normalized
  on public.contacts (phone_normalized)
  where phone_normalized is not null;
