-- Run once in Supabase SQL Editor before deploying the analytics-enabled app.
-- Browser roles receive no table or function access; only the server secret can write.

begin;

create table if not exists public.marketing_attribution (
  visitor_hash text primary key check (visitor_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references auth.users(id) on delete set null,
  first_source text not null default 'direct',
  first_medium text,
  first_campaign text,
  first_content text,
  first_term text,
  first_referrer text,
  first_landing_path text not null default '/',
  first_seen_at timestamptz not null default now(),
  last_source text not null default 'direct',
  last_medium text,
  last_campaign text,
  last_content text,
  last_term text,
  last_referrer text,
  last_landing_path text not null default '/',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_attribution_user_idx
  on public.marketing_attribution(user_id, first_seen_at, last_seen_at);

create table if not exists public.marketing_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (char_length(event_key) between 1 and 180),
  visitor_hash text references public.marketing_attribution(visitor_hash) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  name text not null check (name in (
    'landing_view',
    'auth_started',
    'account_created',
    'login_completed',
    'trial_started',
    'checkout_started',
    'membership_activated',
    'renewal_paid',
    'payment_failed',
    'membership_cancelled',
    'membership_reversed'
  )),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists marketing_events_created_idx on public.marketing_events(created_at desc);
create index if not exists marketing_events_user_idx on public.marketing_events(user_id, created_at desc);
create index if not exists marketing_events_name_idx on public.marketing_events(name, created_at desc);

alter table public.marketing_attribution enable row level security;
alter table public.marketing_events enable row level security;

revoke all on table public.marketing_attribution from public, anon, authenticated;
revoke all on table public.marketing_events from public, anon, authenticated;
grant all on table public.marketing_attribution to service_role;
grant all on table public.marketing_events to service_role;

create or replace function public.record_marketing_attribution(
  p_visitor_hash text,
  p_user_id uuid,
  p_first jsonb,
  p_last jsonb
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_visitor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_VISITOR_HASH';
  end if;

  insert into public.marketing_attribution (
    visitor_hash,
    user_id,
    first_source,
    first_medium,
    first_campaign,
    first_content,
    first_term,
    first_referrer,
    first_landing_path,
    last_source,
    last_medium,
    last_campaign,
    last_content,
    last_term,
    last_referrer,
    last_landing_path
  ) values (
    p_visitor_hash,
    p_user_id,
    coalesce(nullif(p_first->>'source', ''), 'direct'),
    nullif(p_first->>'medium', ''),
    nullif(p_first->>'campaign', ''),
    nullif(p_first->>'content', ''),
    nullif(p_first->>'term', ''),
    nullif(p_first->>'referrer', ''),
    coalesce(nullif(p_first->>'landing_path', ''), '/'),
    coalesce(nullif(p_last->>'source', ''), 'direct'),
    nullif(p_last->>'medium', ''),
    nullif(p_last->>'campaign', ''),
    nullif(p_last->>'content', ''),
    nullif(p_last->>'term', ''),
    nullif(p_last->>'referrer', ''),
    coalesce(nullif(p_last->>'landing_path', ''), '/')
  )
  on conflict (visitor_hash) do update set
    user_id = coalesce(excluded.user_id, public.marketing_attribution.user_id),
    last_source = excluded.last_source,
    last_medium = excluded.last_medium,
    last_campaign = excluded.last_campaign,
    last_content = excluded.last_content,
    last_term = excluded.last_term,
    last_referrer = excluded.last_referrer,
    last_landing_path = excluded.last_landing_path,
    last_seen_at = now(),
    updated_at = now();
end;
$$;

revoke all on function public.record_marketing_attribution(text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_marketing_attribution(text, uuid, jsonb, jsonb) to service_role;

commit;
