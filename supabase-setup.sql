create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  access_until timestamptz,
  subscription_status text not null default 'none',
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_key_hash text not null,
  fingerprint_hash text not null,
  name text not null,
  last_ip_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, device_key_hash)
);

create table if not exists public.trial_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  fingerprint_hash text not null unique,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.watch_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  content_key text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text not null,
  amount numeric,
  currency text,
  payload jsonb,
  created_at timestamptz not null default now(),
  unique(provider, external_id)
);

create index if not exists devices_user_active_idx on public.devices(user_id, revoked_at);
create index if not exists trial_claims_ip_idx on public.trial_claims(ip_hash);
create index if not exists watch_sessions_active_idx on public.watch_sessions(user_id, ended_at, last_seen_at);
create index if not exists profiles_stripe_customer_idx on public.profiles(stripe_customer_id);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.trial_claims enable row level security;
alter table public.watch_sessions enable row level security;
alter table public.payment_events enable row level security;

revoke all on public.profiles, public.devices, public.trial_claims, public.watch_sessions, public.payment_events from anon, authenticated;
grant all on public.profiles, public.devices, public.trial_claims, public.watch_sessions, public.payment_events to service_role;
