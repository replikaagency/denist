-- Real appointments table for booking persistence.
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_name text not null,
  phone text not null,
  datetime_start timestamptz not null,
  datetime_end timestamptz not null,
  status text not null check (status in ('pending', 'confirmed', 'cancelled', 'rescheduled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (datetime_end > datetime_start)
);

create index if not exists idx_appointments_phone on public.appointments(phone);
create index if not exists idx_appointments_time on public.appointments(datetime_start, datetime_end);
create index if not exists idx_appointments_status on public.appointments(status);
