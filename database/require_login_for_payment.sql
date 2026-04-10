-- ==================================================
-- REQUIRE LOGIN FOR PAYMENT SUBMISSIONS
-- Run after:
--   1) database/setup_security_rate_limits.sql
--   2) database/setup_shared_users_create_account.sql
--   3) database/payment_system_setup.sql
-- ==================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.user_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    session_token_hash text not null,
    app_context text not null default 'billing',
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '30 days'),
    revoked_at timestamptz
);

alter table public.user_sessions add column if not exists user_id uuid;
alter table public.user_sessions add column if not exists session_token_hash text;
alter table public.user_sessions add column if not exists app_context text default 'billing';
alter table public.user_sessions add column if not exists created_at timestamptz default now();
alter table public.user_sessions add column if not exists last_seen_at timestamptz default now();
alter table public.user_sessions add column if not exists expires_at timestamptz default (now() + interval '30 days');
alter table public.user_sessions add column if not exists revoked_at timestamptz;

create unique index if not exists idx_user_sessions_token_hash on public.user_sessions (session_token_hash);
create index if not exists idx_user_sessions_user_id on public.user_sessions (user_id);
create index if not exists idx_user_sessions_active on public.user_sessions (user_id, expires_at)
where revoked_at is null;

alter table public.payment_submissions add column if not exists submitted_by_user_id uuid;
alter table public.payment_submissions add column if not exists submitted_by_username text;

create index if not exists idx_payment_submissions_submitted_by_user_id
on public.payment_submissions (submitted_by_user_id);

create or replace function public.custom_login(
    p_username text,
    p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user public.users%rowtype;
    v_username text;
    v_password text;
    v_password_ok boolean := false;
    v_rate_limit jsonb;
    v_session_token text;
    v_session_token_hash text;
    v_session_expires_at timestamptz := now() + interval '30 days';
begin
    v_username := trim(coalesce(p_username, ''));
    v_password := coalesce(p_password, '');

    if v_username = '' or v_password = '' then
        return json_build_object('success', false, 'error', 'Username and password are required.');
    end if;

    v_rate_limit := public.security_check_rate_limit(
        'custom_login',
        public.security_request_subject(format('login:%s', lower(v_username))),
        8,
        600,
        1800,
        jsonb_build_object('username', left(lower(v_username), 60))
    );

    if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
        return json_build_object('success', false, 'error', 'Too many login attempts. Please wait before trying again.');
    end if;

    select u.*
    into v_user
    from public.users u
    where lower(u.username) = lower(v_username)
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Invalid username or password.');
    end if;

    if coalesce(v_user.is_blocked, false) then
        return json_build_object('success', false, 'error', 'This account is blocked. Please contact admin.');
    end if;

    if v_user.restricted_until is not null and v_user.restricted_until > now() then
        return json_build_object('success', false, 'error', 'This account is temporarily restricted.');
    end if;

    if coalesce(v_user.password_hash, '') <> '' then
        if left(v_user.password_hash, 3) in ('$2a', '$2b', '$2y') then
            v_password_ok := (v_user.password_hash = crypt(v_password, v_user.password_hash));
        elsif v_user.password_hash ~ '^[0-9a-f]{64}$' then
            v_password_ok := (v_user.password_hash = encode(digest(v_password, 'sha256'), 'hex'));
        elsif v_user.password_hash ~ '^[0-9a-f]{32}$' then
            v_password_ok := (v_user.password_hash = md5(v_password));
        end if;
    end if;

    if not coalesce(v_password_ok, false) then
        return json_build_object('success', false, 'error', 'Invalid username or password.');
    end if;

    delete from public.user_sessions
    where expires_at < now() - interval '7 days'
       or (revoked_at is not null and revoked_at < now() - interval '7 days');

    v_session_token := encode(gen_random_bytes(32), 'hex');
    v_session_token_hash := encode(digest(v_session_token, 'sha256'), 'hex');

    insert into public.user_sessions (
        user_id,
        session_token_hash,
        app_context,
        expires_at
    ) values (
        v_user.id,
        v_session_token_hash,
        'billing',
        v_session_expires_at
    );

    update public.users
    set
        last_active = now(),
        updated_at = now()
    where id = v_user.id;

    return json_build_object(
        'success', true,
        'user', json_build_object(
            'id', v_user.id,
            'username', v_user.username,
            'first_name', v_user.first_name,
            'last_name', v_user.last_name,
            'contact_info', v_user.contact_info,
            'role', coalesce(v_user.role, 'user'),
            'tenant_location', v_user.tenant_location
        ),
        'session', json_build_object(
            'token', v_session_token,
            'expires_at', v_session_expires_at
        )
    );
exception
    when others then
        return json_build_object('success', false, 'error', 'Unable to sign in right now.');
end;
$$;

grant execute on function public.custom_login(text, text) to anon, authenticated;

create or replace function public.verify_user_session(
    p_session_token text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_token text;
    v_token_hash text;
    v_session public.user_sessions%rowtype;
    v_user public.users%rowtype;
begin
    v_token := trim(coalesce(p_session_token, ''));
    if v_token = '' then
        return json_build_object('success', false, 'error', 'Missing session token.');
    end if;

    v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

    select s.*
    into v_session
    from public.user_sessions s
    where s.session_token_hash = v_token_hash
      and s.app_context = 'billing'
      and s.revoked_at is null
    order by s.created_at desc
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Session expired. Please sign in again.');
    end if;

    if v_session.expires_at <= now() then
        update public.user_sessions
        set revoked_at = coalesce(revoked_at, now())
        where id = v_session.id;

        return json_build_object('success', false, 'error', 'Session expired. Please sign in again.');
    end if;

    select u.*
    into v_user
    from public.users u
    where u.id = v_session.user_id
    limit 1;

    if not found then
        update public.user_sessions
        set revoked_at = coalesce(revoked_at, now())
        where id = v_session.id;

        return json_build_object('success', false, 'error', 'Account not found. Please sign in again.');
    end if;

    if coalesce(v_user.is_blocked, false) then
        update public.user_sessions
        set revoked_at = coalesce(revoked_at, now())
        where id = v_session.id;

        return json_build_object('success', false, 'error', 'This account is blocked. Please contact admin.');
    end if;

    if v_user.restricted_until is not null and v_user.restricted_until > now() then
        update public.user_sessions
        set revoked_at = coalesce(revoked_at, now())
        where id = v_session.id;

        return json_build_object('success', false, 'error', 'This account is temporarily restricted.');
    end if;

    update public.user_sessions
    set last_seen_at = now()
    where id = v_session.id;

    update public.users
    set last_active = now(),
        updated_at = now()
    where id = v_user.id;

    return json_build_object(
        'success', true,
        'user', json_build_object(
            'id', v_user.id,
            'username', v_user.username,
            'first_name', v_user.first_name,
            'last_name', v_user.last_name,
            'contact_info', v_user.contact_info,
            'role', coalesce(v_user.role, 'user'),
            'tenant_location', v_user.tenant_location
        ),
        'session', json_build_object(
            'expires_at', v_session.expires_at
        )
    );
exception
    when others then
        return json_build_object('success', false, 'error', 'Unable to verify session right now.');
end;
$$;

grant execute on function public.verify_user_session(text) to anon, authenticated;

create or replace function public.custom_logout(
    p_session_token text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_token text;
    v_token_hash text;
begin
    v_token := trim(coalesce(p_session_token, ''));
    if v_token = '' then
        return json_build_object('success', true);
    end if;

    v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

    update public.user_sessions
    set revoked_at = coalesce(revoked_at, now())
    where session_token_hash = v_token_hash
      and app_context = 'billing';

    return json_build_object('success', true);
exception
    when others then
        return json_build_object('success', false, 'error', 'Unable to sign out right now.');
end;
$$;

grant execute on function public.custom_logout(text) to anon, authenticated;

create or replace function public.submit_payment_authenticated(
    p_session_token text,
    p_sender_gcash_number text,
    p_sender_full_name text,
    p_sender_contact_number text,
    p_room_no text,
    p_amount_to_pay numeric,
    p_receipt_image_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    new_id uuid;
    v_rate_limit jsonb;
    v_user public.users%rowtype;
    v_session public.user_sessions%rowtype;
    v_token text;
    v_token_hash text;
    v_room_no text;
    v_sender_gcash text;
    v_sender_name text;
    v_sender_contact text;
    v_account_room text;
begin
    v_token := trim(coalesce(p_session_token, ''));
    v_room_no := trim(coalesce(p_room_no, ''));
    v_sender_gcash := trim(coalesce(p_sender_gcash_number, ''));
    v_sender_name := trim(coalesce(p_sender_full_name, ''));
    v_sender_contact := trim(coalesce(p_sender_contact_number, ''));

    if v_token = '' then
        raise exception 'Sign in is required before submitting payment.';
    end if;

    if v_sender_gcash = '' or v_sender_name = '' or v_sender_contact = '' or v_room_no = '' then
        raise exception 'All payment fields are required.';
    end if;

    if p_amount_to_pay is null or p_amount_to_pay <= 0 then
        raise exception 'Payment amount must be greater than zero.';
    end if;

    v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

    select s.*
    into v_session
    from public.user_sessions s
    where s.session_token_hash = v_token_hash
      and s.app_context = 'billing'
      and s.revoked_at is null
    order by s.created_at desc
    limit 1;

    if not found or v_session.expires_at <= now() then
        raise exception 'Your session expired. Please sign in again.';
    end if;

    select u.*
    into v_user
    from public.users u
    where u.id = v_session.user_id
    limit 1;

    if not found then
        raise exception 'Account not found. Please sign in again.';
    end if;

    if coalesce(v_user.is_blocked, false) then
        raise exception 'This account is blocked. Please contact admin.';
    end if;

    if v_user.restricted_until is not null and v_user.restricted_until > now() then
        raise exception 'This account is temporarily restricted.';
    end if;

    v_account_room := trim(coalesce(v_user.tenant_location, ''));
    if v_account_room <> '' and lower(v_account_room) <> lower(v_room_no) then
        raise exception 'This account can only submit payment for room %.', v_account_room;
    end if;

    v_rate_limit := public.security_check_rate_limit(
        'submit_payment_authenticated',
        public.security_request_subject(format('payment:%s:%s', v_user.id::text, lower(v_room_no))),
        5,
        600,
        3600,
        jsonb_build_object(
            'room_no', left(v_room_no, 40),
            'action', 'submit_payment_authenticated',
            'user_id', v_user.id::text
        )
    );

    if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
        raise exception 'Too many payment submissions from this network. Please wait before trying again.';
    end if;

    update public.user_sessions
    set last_seen_at = now()
    where id = v_session.id;

    update public.users
    set last_active = now(),
        updated_at = now()
    where id = v_user.id;

    insert into public.payment_submissions (
        sender_gcash_number,
        sender_full_name,
        sender_contact_number,
        room_no,
        amount_to_pay,
        receipt_image_url,
        status,
        submitted_by_user_id,
        submitted_by_username
    ) values (
        v_sender_gcash,
        v_sender_name,
        v_sender_contact,
        v_room_no,
        p_amount_to_pay,
        nullif(trim(coalesce(p_receipt_image_url, '')), ''),
        'PENDING',
        v_user.id,
        v_user.username
    )
    returning id into new_id;

    return new_id;
end;
$$;

grant execute on function public.submit_payment_authenticated(text, text, text, text, text, numeric, text) to anon, authenticated;

do $$
begin
    revoke execute on function public.submit_payment(text, text, text, text, numeric, text) from anon, authenticated;
exception
    when undefined_function then
        null;
end;
$$;
