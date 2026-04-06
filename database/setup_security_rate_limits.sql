-- =========================================================
-- SECURITY RATE LIMIT SHIELD
-- Shared anti-abuse primitives for public RPCs and Edge Functions
-- Run this in Supabase SQL Editor before enabling the guarded functions
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.security_rate_limits (
    scope text not null,
    subject_hash text not null,
    subject_hint text,
    request_count integer not null default 0 check (request_count >= 0),
    window_started_at timestamptz not null default now(),
    blocked_until timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    primary key (scope, subject_hash)
);

create index if not exists idx_security_rate_limits_updated_at
    on public.security_rate_limits (updated_at);

create index if not exists idx_security_rate_limits_blocked_until
    on public.security_rate_limits (blocked_until)
    where blocked_until is not null;

alter table public.security_rate_limits enable row level security;

create or replace function public.security_rate_limits_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_security_rate_limits_set_updated_at on public.security_rate_limits;
create trigger trg_security_rate_limits_set_updated_at
before update on public.security_rate_limits
for each row
execute function public.security_rate_limits_set_updated_at();

create or replace function public.security_request_subject(
    p_suffix text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
    v_ip text;
    v_user_agent text;
    v_suffix text := nullif(trim(coalesce(p_suffix, '')), '');
begin
    v_ip := trim(
        coalesce(
            v_headers ->> 'cf-connecting-ip',
            split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1),
            v_headers ->> 'x-real-ip',
            'unknown-ip'
        )
    );

    v_user_agent := left(trim(coalesce(v_headers ->> 'user-agent', 'unknown-agent')), 120);

    return concat_ws('|', nullif(v_ip, ''), nullif(v_user_agent, ''), v_suffix);
end;
$$;

create or replace function public.security_check_rate_limit(
    p_scope text,
    p_subject text,
    p_max_requests integer,
    p_window_seconds integer,
    p_block_seconds integer default null,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_scope text := nullif(trim(coalesce(p_scope, '')), '');
    v_subject text := coalesce(nullif(trim(coalesce(p_subject, '')), ''), 'anonymous');
    v_subject_hash text := encode(digest(v_subject, 'sha256'), 'hex');
    v_subject_hint text := left(v_subject, 80);
    v_window interval;
    v_block interval;
    v_row public.security_rate_limits%rowtype;
    v_allowed boolean := false;
    v_remaining integer := 0;
    v_reset_at timestamptz;
    v_retry_after_seconds integer := 0;
    v_blocked_until timestamptz;
begin
    if v_scope is null then
        raise exception 'security scope is required';
    end if;

    if coalesce(p_max_requests, 0) < 1 or p_max_requests > 10000 then
        raise exception 'max requests must be between 1 and 10000';
    end if;

    if coalesce(p_window_seconds, 0) < 1 or p_window_seconds > 86400 then
        raise exception 'window seconds must be between 1 and 86400';
    end if;

    if p_block_seconds is null then
        p_block_seconds := greatest(p_window_seconds * 2, 60);
    end if;

    if p_block_seconds < 0 or p_block_seconds > 604800 then
        raise exception 'block seconds must be between 0 and 604800';
    end if;

    v_window := make_interval(secs => p_window_seconds);
    v_block := make_interval(secs => p_block_seconds);

    select *
    into v_row
    from public.security_rate_limits
    where scope = v_scope
      and subject_hash = v_subject_hash
    for update;

    if not found then
        insert into public.security_rate_limits (
            scope,
            subject_hash,
            subject_hint,
            request_count,
            window_started_at,
            blocked_until,
            metadata,
            created_at,
            updated_at,
            last_seen_at
        )
        values (
            v_scope,
            v_subject_hash,
            v_subject_hint,
            1,
            v_now,
            null,
            coalesce(p_metadata, '{}'::jsonb),
            v_now,
            v_now,
            v_now
        );

        v_allowed := true;
        v_remaining := greatest(p_max_requests - 1, 0);
        v_reset_at := v_now + v_window;
    elsif v_row.blocked_until is not null and v_row.blocked_until > v_now then
        update public.security_rate_limits
        set
            metadata = coalesce(p_metadata, metadata),
            last_seen_at = v_now
        where scope = v_scope
          and subject_hash = v_subject_hash;

        v_allowed := false;
        v_remaining := 0;
        v_reset_at := v_row.blocked_until;
        v_retry_after_seconds := greatest(ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer, 1);
    elsif v_row.window_started_at + v_window <= v_now then
        update public.security_rate_limits
        set
            request_count = 1,
            window_started_at = v_now,
            blocked_until = null,
            metadata = coalesce(p_metadata, metadata),
            last_seen_at = v_now
        where scope = v_scope
          and subject_hash = v_subject_hash;

        v_allowed := true;
        v_remaining := greatest(p_max_requests - 1, 0);
        v_reset_at := v_now + v_window;
    elsif v_row.request_count + 1 > p_max_requests then
        v_blocked_until := case
            when p_block_seconds > 0 then v_now + v_block
            else v_row.window_started_at + v_window
        end;

        update public.security_rate_limits
        set
            request_count = v_row.request_count + 1,
            blocked_until = v_blocked_until,
            metadata = coalesce(p_metadata, metadata),
            last_seen_at = v_now
        where scope = v_scope
          and subject_hash = v_subject_hash;

        v_allowed := false;
        v_remaining := 0;
        v_reset_at := v_blocked_until;
        v_retry_after_seconds := greatest(ceil(extract(epoch from (v_blocked_until - v_now)))::integer, 1);
    else
        update public.security_rate_limits
        set
            request_count = v_row.request_count + 1,
            metadata = coalesce(p_metadata, metadata),
            last_seen_at = v_now
        where scope = v_scope
          and subject_hash = v_subject_hash;

        v_allowed := true;
        v_remaining := greatest(p_max_requests - (v_row.request_count + 1), 0);
        v_reset_at := v_row.window_started_at + v_window;
    end if;

    return jsonb_build_object(
        'allowed', v_allowed,
        'scope', v_scope,
        'remaining', v_remaining,
        'reset_at', v_reset_at,
        'retry_after_seconds', v_retry_after_seconds,
        'blocked_until', v_reset_at
    );
end;
$$;

create or replace function public.security_prune_rate_limits(
    p_keep_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_deleted integer := 0;
begin
    if coalesce(p_keep_days, 0) < 1 or p_keep_days > 90 then
        raise exception 'keep days must be between 1 and 90';
    end if;

    delete from public.security_rate_limits
    where updated_at < now() - make_interval(days => p_keep_days);

    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke all on public.security_rate_limits from anon, authenticated;

grant execute on function public.security_request_subject(text) to anon, authenticated, service_role;
grant execute on function public.security_check_rate_limit(text, text, integer, integer, integer, jsonb) to service_role;
grant execute on function public.security_prune_rate_limits(integer) to service_role;
