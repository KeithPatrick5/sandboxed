-- Run once in Supabase SQL Editor before deploying the monthly-plan app update.
-- Safe to run more than once.

alter table public.profiles add column if not exists membership_plan text;
alter table public.profiles add column if not exists membership_provider text;

-- All memberships sold before this update were annual. Preserve them and
-- identify Stripe-backed accounts without shortening anyone's access.
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
