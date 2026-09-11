create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  access_until timestamptz,
  subscription_status text not null default 'none',
  membership_plan text,
  membership_provider text,
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
  fingerprint_v2_hash text,
  name text not null,
  last_ip_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, device_key_hash)
);

create table if not exists public.trial_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  fingerprint_hash text not null unique,
  fingerprint_v2_hash text,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

-- Trial claims must survive account deletion. Otherwise a person could delete
-- an account, register another email, and claim the same free trial again.
alter table public.trial_claims drop constraint if exists trial_claims_user_id_fkey;
alter table public.trial_claims alter column user_id drop not null;
alter table public.trial_claims
  add constraint trial_claims_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- Safe upgrades for projects created from an earlier version of this file.
alter table public.profiles add column if not exists membership_plan text;
alter table public.profiles add column if not exists membership_provider text;
update public.profiles
set membership_plan = coalesce(membership_plan, 'annual'),
    membership_provider = coalesce(
      membership_provider,
      case when stripe_customer_id is not null then 'stripe' else 'nowpayments' end
    )
where access_until is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_membership_plan_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_membership_plan_check
      check (membership_plan is null or membership_plan in ('monthly', 'annual'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_membership_provider_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_membership_provider_check
      check (membership_provider is null or membership_provider in ('stripe', 'nowpayments'));
  end if;
end
$$;

alter table public.devices add column if not exists fingerprint_v2_hash text;
alter table public.trial_claims add column if not exists fingerprint_v2_hash text;
create unique index if not exists trial_claims_fingerprint_v2_idx
  on public.trial_claims(fingerprint_v2_hash)
  where fingerprint_v2_hash is not null;

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

-- Serialize stream allocation per account so concurrent Play requests cannot
-- both observe an available slot and exceed the two-stream limit.
create or replace function public.begin_watch_session_atomic(
  p_user_id uuid,
  p_device_id uuid,
  p_content_key text,
  p_stream_ttl_seconds integer default 150,
  p_max_streams integer default 2
)
returns setof public.watch_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cutoff timestamptz;
  v_other_devices integer;
  v_session public.watch_sessions;
begin
  if p_stream_ttl_seconds < 30 or p_stream_ttl_seconds > 3600
     or p_max_streams < 1 or p_max_streams > 20 then
    raise exception 'INVALID_STREAM_POLICY';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  v_cutoff := v_now - pg_catalog.make_interval(secs => p_stream_ttl_seconds);

  update public.watch_sessions
     set ended_at = v_now
   where user_id = p_user_id
     and ended_at is null
     and last_seen_at < v_cutoff;

  select count(distinct device_id)
    into v_other_devices
    from public.watch_sessions
   where user_id = p_user_id
     and device_id <> p_device_id
     and ended_at is null
     and last_seen_at >= v_cutoff;

  if v_other_devices >= p_max_streams then
    raise exception 'STREAM_LIMIT';
  end if;

  update public.watch_sessions
     set ended_at = v_now
   where user_id = p_user_id
     and device_id = p_device_id
     and ended_at is null;

  insert into public.watch_sessions(user_id, device_id, content_key, last_seen_at)
  values (p_user_id, p_device_id, left(coalesce(p_content_key, ''), 120), v_now)
  returning * into v_session;

  return next v_session;
end;
$$;

revoke all on function public.begin_watch_session_atomic(uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.begin_watch_session_atomic(uuid, uuid, text, integer, integer) to service_role;

-- Serialize registration per account so parallel requests cannot exceed the
-- device cap or create competing rows for the same browser identifier.
create or replace function public.register_device_atomic(
  p_user_id uuid,
  p_device_key_hash text,
  p_fingerprint_hash text,
  p_fingerprint_v2_hash text,
  p_name text,
  p_last_ip_hash text,
  p_max_devices integer default 4
)
returns setof public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_active_devices integer;
  v_device public.devices;
begin
  if p_max_devices < 1 or p_max_devices > 20
     or p_device_key_hash !~ '^[0-9a-f]{64}$'
     or p_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_last_ip_hash !~ '^[0-9a-f]{64}$'
     or (p_fingerprint_v2_hash is not null and p_fingerprint_v2_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'INVALID_DEVICE';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  select * into v_device
    from public.devices
   where user_id = p_user_id
     and device_key_hash = p_device_key_hash
   for update;

  if v_device.id is not null and v_device.revoked_at is null then
    update public.devices
       set fingerprint_hash = p_fingerprint_hash,
           fingerprint_v2_hash = p_fingerprint_v2_hash,
           name = left(coalesce(p_name, 'Device'), 80),
           last_ip_hash = p_last_ip_hash,
           last_seen_at = v_now
     where id = v_device.id
     returning * into v_device;
    return next v_device;
    return;
  end if;

  select count(*) into v_active_devices
    from public.devices
   where user_id = p_user_id
     and revoked_at is null;

  if v_active_devices >= p_max_devices then
    raise exception 'DEVICE_LIMIT';
  end if;

  if v_device.id is not null then
    update public.devices
       set device_key_hash = 'retired:' || v_device.id::text || ':' || p_device_key_hash
     where id = v_device.id;
  end if;

  insert into public.devices(
    user_id, device_key_hash, fingerprint_hash, fingerprint_v2_hash,
    name, last_ip_hash, last_seen_at
  ) values (
    p_user_id, p_device_key_hash, p_fingerprint_hash, p_fingerprint_v2_hash,
    left(coalesce(p_name, 'Device'), 80), p_last_ip_hash, v_now
  ) returning * into v_device;

  return next v_device;
end;
$$;

revoke all on function public.register_device_atomic(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.register_device_atomic(uuid, text, text, text, text, text, integer) to service_role;

-- Count replacement use and revoke the selected device in the same locked
-- transaction. Active playback on that device is ended before returning.
create or replace function public.revoke_device_atomic(
  p_user_id uuid,
  p_device_id uuid,
  p_max_replacements integer default 2
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_recent_replacements integer;
  v_device_id uuid;
begin
  if p_max_replacements < 1 or p_max_replacements > 20 then
    raise exception 'INVALID_REPLACEMENT_POLICY';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  select id into v_device_id
    from public.devices
   where id = p_device_id
     and user_id = p_user_id
     and revoked_at is null
   for update;

  if v_device_id is null then
    raise exception 'DEVICE_NOT_FOUND';
  end if;

  select count(*) into v_recent_replacements
    from public.devices
   where user_id = p_user_id
     and revoked_at > v_now - interval '30 days';

  if v_recent_replacements >= p_max_replacements then
    raise exception 'REPLACEMENT_LIMIT';
  end if;

  update public.devices
     set revoked_at = v_now
   where id = v_device_id;

  update public.watch_sessions
     set ended_at = v_now
   where user_id = p_user_id
     and device_id = v_device_id
     and ended_at is null;
end;
$$;

revoke all on function public.revoke_device_atomic(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.revoke_device_atomic(uuid, uuid, integer) to service_role;
