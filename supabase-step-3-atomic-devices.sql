-- Run this once in the Sandboxed Supabase SQL Editor before deploying the
-- matching application code.
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
