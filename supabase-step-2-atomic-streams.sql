-- Run this once in the Sandboxed Supabase SQL Editor before deploying the
-- matching application code.
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
