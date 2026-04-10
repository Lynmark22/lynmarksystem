-- =========================================================
-- SHARED USERS SCHEMA + CREATE ACCOUNT RPC
-- Purpose:
--   1) Keep this app aligned with the shared users schema.
--   2) Allow public create-account via RPC using secure hashing.
-- Run database/setup_security_rate_limits.sql first for anti-abuse checks.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.users (
    id uuid not null default gen_random_uuid(),
    username character varying(50) not null,
    first_name character varying(100) not null,
    last_name character varying(100) not null,
    contact_info character varying(255) not null,
    password_hash text not null,
    security_question_1 character varying(255),
    security_answer_1_hash text not null,
    security_question_2 character varying(255),
    security_answer_2_hash text not null,
    security_question_3 character varying(255),
    security_answer_3_hash text,
    created_at timestamp without time zone default now(),
    updated_at timestamp without time zone default now(),
    role character varying(20) default 'user'::character varying,
    last_active timestamp without time zone default now(),
    birthdate date,
    secret_question_1 text,
    secret_answer_1 text,
    secret_question_2 text,
    secret_answer_2 text,
    security_answer_1 text,
    security_answer_2 text,
    profile_picture_url text,
    restricted_until timestamp with time zone,
    restriction_reason text,
    is_blocked boolean default false,
    blocked_at timestamp with time zone,
    blocked_reason text,
    tenant_location text,
    constraint users_pkey primary key (id),
    constraint users_username_key unique (username)
);

alter table public.users add column if not exists username character varying(50);
alter table public.users add column if not exists first_name character varying(100);
alter table public.users add column if not exists last_name character varying(100);
alter table public.users add column if not exists contact_info character varying(255);
alter table public.users add column if not exists password_hash text;
alter table public.users add column if not exists security_question_1 character varying(255);
alter table public.users add column if not exists security_answer_1_hash text;
alter table public.users add column if not exists security_question_2 character varying(255);
alter table public.users add column if not exists security_answer_2_hash text;
alter table public.users add column if not exists security_question_3 character varying(255);
alter table public.users add column if not exists security_answer_3_hash text;
alter table public.users add column if not exists created_at timestamp without time zone default now();
alter table public.users add column if not exists updated_at timestamp without time zone default now();
alter table public.users add column if not exists role character varying(20) default 'user'::character varying;
alter table public.users add column if not exists last_active timestamp without time zone default now();
alter table public.users add column if not exists birthdate date;
alter table public.users add column if not exists secret_question_1 text;
alter table public.users add column if not exists secret_answer_1 text;
alter table public.users add column if not exists secret_question_2 text;
alter table public.users add column if not exists secret_answer_2 text;
alter table public.users add column if not exists security_answer_1 text;
alter table public.users add column if not exists security_answer_2 text;
alter table public.users add column if not exists profile_picture_url text;
alter table public.users add column if not exists restricted_until timestamp with time zone;
alter table public.users add column if not exists restriction_reason text;
alter table public.users add column if not exists is_blocked boolean default false;
alter table public.users add column if not exists blocked_at timestamp with time zone;
alter table public.users add column if not exists blocked_reason text;
alter table public.users add column if not exists tenant_location text;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'users_username_key'
          and conrelid = 'public.users'::regclass
    ) then
        alter table public.users add constraint users_username_key unique (username);
    end if;
exception
    when undefined_table then
        null;
    when others then
        -- Keep migration non-blocking if legacy data violates uniqueness.
        null;
end;
$$;

do $$
begin
    alter table public.users alter column username set not null;
    alter table public.users alter column first_name set not null;
    alter table public.users alter column last_name set not null;
    alter table public.users alter column contact_info set not null;
    alter table public.users alter column password_hash set not null;
    alter table public.users alter column security_answer_1_hash set not null;
    alter table public.users alter column security_answer_2_hash set not null;
exception
    when others then
        -- Skip hardening if legacy rows violate not-null in existing installs.
        null;
end;
$$;

do $$
begin
    alter table public.users alter column security_question_3 drop not null;
    alter table public.users alter column security_answer_3_hash drop not null;
exception
    when others then
        null;
end;
$$;

do $$
begin
    alter table public.users alter column created_at set default now();
    alter table public.users alter column updated_at set default now();
    alter table public.users alter column role set default 'user'::character varying;
    alter table public.users alter column last_active set default now();
    alter table public.users alter column is_blocked set default false;
exception
    when undefined_table then
        null;
    when others then
        null;
end;
$$;

create index if not exists idx_users_username on public.users using btree (username);
create index if not exists idx_users_role on public.users using btree (role);
create index if not exists idx_users_last_active on public.users using btree (last_active);
create index if not exists idx_users_username_lower on public.users using btree (lower((username)::text));
create index if not exists idx_users_is_blocked on public.users using btree (is_blocked)
where (is_blocked = true);
create index if not exists idx_users_restricted_until on public.users using btree (restricted_until)
where (restricted_until is not null);

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

do $$
begin
    -- Compatibility migration:
    -- Convert legacy/non-SHA answer hashes to SHA-256 when plaintext answers exist.
    update public.users
    set
        security_answer_1_hash = case
            when coalesce(trim(security_answer_1), '') <> ''
                then encode(extensions.digest(trim(security_answer_1), 'sha256'), 'hex')
            else security_answer_1_hash
        end,
        security_answer_2_hash = case
            when coalesce(trim(security_answer_2), '') <> ''
                then encode(extensions.digest(trim(security_answer_2), 'sha256'), 'hex')
            else security_answer_2_hash
        end
    where
        (coalesce(trim(security_answer_1), '') <> '' and coalesce(lower(security_answer_1_hash), '') !~ '^[0-9a-f]{64}$')
        or
        (coalesce(trim(security_answer_2), '') <> '' and coalesce(lower(security_answer_2_hash), '') !~ '^[0-9a-f]{64}$');
exception
    when others then
        null;
end;
$$;

create or replace function public.users_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_users_set_updated_at on public.users;
create trigger trg_users_set_updated_at
before update on public.users
for each row
execute function public.users_set_updated_at();

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
        -- Support existing bcrypt hashes.
        if left(v_user.password_hash, 3) in ('$2a', '$2b', '$2y') then
            v_password_ok := (v_user.password_hash = crypt(v_password, v_user.password_hash));
        -- Support shared-site SHA-256 hex hashes.
        elsif v_user.password_hash ~ '^[0-9a-f]{64}$' then
            v_password_ok := (v_user.password_hash = encode(digest(v_password, 'sha256'), 'hex'));
        -- Optional legacy fallback (MD5).
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

create or replace function public.custom_register_user(
    p_username text,
    p_password text,
    p_first_name text,
    p_last_name text,
    p_contact_info text,
    p_birthdate date default null,
    p_tenant_location text default null,
    p_security_question_1 text default null,
    p_security_answer_1 text default null,
    p_security_question_2 text default null,
    p_security_answer_2 text default null,
    p_security_question_3 text default null,
    p_security_answer_3 text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_username text;
    v_first_name text;
    v_last_name text;
    v_contact_info text;
    v_password text;
    v_security_question_1 text;
    v_security_answer_1 text;
    v_security_question_2 text;
    v_security_answer_2 text;
    v_security_question_3 text;
    v_security_answer_3 text;
    v_new_user public.users%rowtype;
begin
    v_username := trim(coalesce(p_username, ''));
    v_first_name := trim(coalesce(p_first_name, ''));
    v_last_name := trim(coalesce(p_last_name, ''));
    v_contact_info := trim(coalesce(p_contact_info, ''));
    v_password := coalesce(p_password, '');
    v_security_question_1 := nullif(trim(coalesce(p_security_question_1, '')), '');
    v_security_answer_1 := trim(coalesce(p_security_answer_1, ''));
    v_security_question_2 := nullif(trim(coalesce(p_security_question_2, '')), '');
    v_security_answer_2 := trim(coalesce(p_security_answer_2, ''));
    v_security_question_3 := trim(coalesce(p_security_question_3, ''));
    v_security_answer_3 := trim(coalesce(p_security_answer_3, ''));

    if v_username = '' then
        return json_build_object('success', false, 'error', 'Username is required.');
    end if;

    if length(v_username) < 3 or length(v_username) > 50 then
        return json_build_object('success', false, 'error', 'Username must be between 3 and 50 characters.');
    end if;

    if v_first_name = '' or v_last_name = '' then
        return json_build_object('success', false, 'error', 'First name and last name are required.');
    end if;

    if v_contact_info = '' then
        return json_build_object('success', false, 'error', 'Contact information is required.');
    end if;

    if length(v_password) < 6 then
        return json_build_object('success', false, 'error', 'Password must be at least 6 characters.');
    end if;

    if p_birthdate is null then
        return json_build_object('success', false, 'error', 'Birthdate is required.');
    end if;

    if coalesce(v_security_question_1, '') = '' or coalesce(v_security_question_2, '') = '' then
        return json_build_object('success', false, 'error', 'All security questions are required.');
    end if;

    if lower(v_security_question_1) = lower(v_security_question_2) then
        return json_build_object('success', false, 'error', 'Please choose 2 different security questions.');
    end if;

    if v_security_answer_1 = '' or v_security_answer_2 = '' then
        return json_build_object('success', false, 'error', 'All security answers are required.');
    end if;

    if exists (
        select 1
        from public.users u
        where lower(u.username) = lower(v_username)
    ) then
        return json_build_object('success', false, 'error', 'Username already exists.');
    end if;

    insert into public.users (
        username,
        first_name,
        last_name,
        contact_info,
        password_hash,
        security_question_1,
        security_answer_1_hash,
        security_question_2,
        security_answer_2_hash,
        security_question_3,
        security_answer_3_hash,
        role,
        last_active,
        birthdate,
        secret_question_1,
        secret_answer_1,
        secret_question_2,
        secret_answer_2,
        security_answer_1,
        security_answer_2,
        tenant_location
    )
    values (
        v_username,
        v_first_name,
        v_last_name,
        v_contact_info,
        encode(digest(v_password, 'sha256'), 'hex'),
        v_security_question_1,
        encode(digest(v_security_answer_1, 'sha256'), 'hex'),
        v_security_question_2,
        encode(digest(v_security_answer_2, 'sha256'), 'hex'),
        nullif(v_security_question_3, ''),
        case when v_security_answer_3 = '' then null else encode(digest(v_security_answer_3, 'sha256'), 'hex') end,
        'user',
        now(),
        p_birthdate,
        v_security_question_1,
        nullif(v_security_answer_1, ''),
        v_security_question_2,
        nullif(v_security_answer_2, ''),
        nullif(v_security_answer_1, ''),
        nullif(v_security_answer_2, ''),
        nullif(trim(coalesce(p_tenant_location, '')), '')
    )
    returning * into v_new_user;

    return json_build_object(
        'success', true,
        'user', json_build_object(
            'id', v_new_user.id,
            'username', v_new_user.username,
            'first_name', v_new_user.first_name,
            'last_name', v_new_user.last_name,
            'role', coalesce(v_new_user.role, 'user')
        )
    );
exception
    when unique_violation then
        return json_build_object('success', false, 'error', 'Username already exists.');
    when others then
        return json_build_object('success', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.custom_register_user(
    text,
    text,
    text,
    text,
    text,
    date,
    text,
    text,
    text,
    text,
    text,
    text,
    text
) to anon, authenticated;

create or replace function public.custom_recovery_lookup_user(
    p_username text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user public.users%rowtype;
    v_username text;
begin
    v_username := trim(coalesce(p_username, ''));

    if v_username = '' then
        return json_build_object('success', false, 'error', 'Username is required.');
    end if;

    select u.*
    into v_user
    from public.users u
    where lower(u.username) = lower(v_username)
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Username not found.');
    end if;

    if coalesce(v_user.is_blocked, false) then
        return json_build_object('success', false, 'error', 'This account is blocked. Please contact admin.');
    end if;

    if v_user.birthdate is null then
        return json_build_object('success', false, 'error', 'Account recovery is unavailable for this account. Contact admin.');
    end if;

    return json_build_object(
        'success', true,
        'username', v_user.username
    );
end;
$$;

grant execute on function public.custom_recovery_lookup_user(text) to anon, authenticated;

create or replace function public.custom_recovery_verify_birthdate(
    p_username text,
    p_birthdate date
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user public.users%rowtype;
    v_username text;
    v_question_1 text;
    v_question_2 text;
begin
    v_username := trim(coalesce(p_username, ''));

    if v_username = '' then
        return json_build_object('success', false, 'error', 'Username is required.');
    end if;

    if p_birthdate is null then
        return json_build_object('success', false, 'error', 'Birthdate is required.');
    end if;

    select u.*
    into v_user
    from public.users u
    where lower(u.username) = lower(v_username)
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Username not found.');
    end if;

    if v_user.birthdate is null or v_user.birthdate <> p_birthdate then
        return json_build_object('success', false, 'error', 'Birthdate verification failed.');
    end if;

    v_question_1 := coalesce(nullif(trim(v_user.security_question_1), ''), nullif(trim(v_user.secret_question_1), ''));
    v_question_2 := coalesce(nullif(trim(v_user.security_question_2), ''), nullif(trim(v_user.secret_question_2), ''));

    if v_question_1 is null or v_question_2 is null then
        return json_build_object('success', false, 'error', 'Security questions are not configured for this account.');
    end if;

    return json_build_object(
        'success', true,
        'question_1', v_question_1,
        'question_2', v_question_2
    );
end;
$$;

grant execute on function public.custom_recovery_verify_birthdate(text, date) to anon, authenticated;

create or replace function public.custom_recovery_verify_answers(
    p_username text,
    p_birthdate date,
    p_answer_1 text,
    p_answer_2 text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user public.users%rowtype;
    v_username text;
    v_answer_1_raw text;
    v_answer_2_raw text;
    v_answer_1_norm text;
    v_answer_2_norm text;
    v_answer_1_sha256 text;
    v_answer_2_sha256 text;
    v_answer_1_sha256_norm text;
    v_answer_2_sha256_norm text;
    v_answer_1_ok boolean;
    v_answer_2_ok boolean;
begin
    v_username := trim(coalesce(p_username, ''));
    v_answer_1_raw := trim(coalesce(p_answer_1, ''));
    v_answer_2_raw := trim(coalesce(p_answer_2, ''));
    v_answer_1_norm := lower(v_answer_1_raw);
    v_answer_2_norm := lower(v_answer_2_raw);
    v_answer_1_sha256 := encode(digest(v_answer_1_raw, 'sha256'), 'hex');
    v_answer_2_sha256 := encode(digest(v_answer_2_raw, 'sha256'), 'hex');
    v_answer_1_sha256_norm := encode(digest(v_answer_1_norm, 'sha256'), 'hex');
    v_answer_2_sha256_norm := encode(digest(v_answer_2_norm, 'sha256'), 'hex');

    if v_username = '' then
        return json_build_object('success', false, 'error', 'Username is required.');
    end if;

    if p_birthdate is null then
        return json_build_object('success', false, 'error', 'Birthdate is required.');
    end if;

    if v_answer_1_raw = '' or v_answer_2_raw = '' then
        return json_build_object('success', false, 'error', 'Both answers are required.');
    end if;

    select u.*
    into v_user
    from public.users u
    where lower(u.username) = lower(v_username)
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Username not found.');
    end if;

    if v_user.birthdate is null or v_user.birthdate <> p_birthdate then
        return json_build_object('success', false, 'error', 'Identity verification failed.');
    end if;

    v_answer_1_ok :=
        (
            coalesce(v_user.security_answer_1_hash, '') <> ''
            and (
                (left(v_user.security_answer_1_hash, 3) in ('$2a', '$2b', '$2y')
                    and v_user.security_answer_1_hash = crypt(v_answer_1_raw, v_user.security_answer_1_hash))
                or
                (lower(v_user.security_answer_1_hash) ~ '^[0-9a-f]{64}$'
                    and lower(v_user.security_answer_1_hash) in (v_answer_1_sha256, v_answer_1_sha256_norm))
                or
                (lower(v_user.security_answer_1_hash) ~ '^[0-9a-f]{32}$'
                    and lower(v_user.security_answer_1_hash) in (md5(v_answer_1_raw), md5(v_answer_1_norm)))
            )
        )
        or (coalesce(trim(v_user.security_answer_1), '') <> '' and lower(trim(v_user.security_answer_1)) = v_answer_1_norm)
        or (coalesce(trim(v_user.secret_answer_1), '') <> '' and lower(trim(v_user.secret_answer_1)) = v_answer_1_norm);

    v_answer_2_ok :=
        (
            coalesce(v_user.security_answer_2_hash, '') <> ''
            and (
                (left(v_user.security_answer_2_hash, 3) in ('$2a', '$2b', '$2y')
                    and v_user.security_answer_2_hash = crypt(v_answer_2_raw, v_user.security_answer_2_hash))
                or
                (lower(v_user.security_answer_2_hash) ~ '^[0-9a-f]{64}$'
                    and lower(v_user.security_answer_2_hash) in (v_answer_2_sha256, v_answer_2_sha256_norm))
                or
                (lower(v_user.security_answer_2_hash) ~ '^[0-9a-f]{32}$'
                    and lower(v_user.security_answer_2_hash) in (md5(v_answer_2_raw), md5(v_answer_2_norm)))
            )
        )
        or (coalesce(trim(v_user.security_answer_2), '') <> '' and lower(trim(v_user.security_answer_2)) = v_answer_2_norm)
        or (coalesce(trim(v_user.secret_answer_2), '') <> '' and lower(trim(v_user.secret_answer_2)) = v_answer_2_norm);

    if not (coalesce(v_answer_1_ok, false) and coalesce(v_answer_2_ok, false)) then
        return json_build_object('success', false, 'error', 'Security answer verification failed.');
    end if;

    return json_build_object('success', true);
end;
$$;

grant execute on function public.custom_recovery_verify_answers(text, date, text, text) to anon, authenticated;

create or replace function public.custom_recovery_reset_password(
    p_username text,
    p_birthdate date,
    p_answer_1 text,
    p_answer_2 text,
    p_new_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_user public.users%rowtype;
    v_username text;
    v_new_password text;
    v_answer_1_raw text;
    v_answer_2_raw text;
    v_answer_1_norm text;
    v_answer_2_norm text;
    v_answer_1_sha256 text;
    v_answer_2_sha256 text;
    v_answer_1_sha256_norm text;
    v_answer_2_sha256_norm text;
    v_answer_1_ok boolean;
    v_answer_2_ok boolean;
begin
    v_username := trim(coalesce(p_username, ''));
    v_new_password := coalesce(p_new_password, '');
    v_answer_1_raw := trim(coalesce(p_answer_1, ''));
    v_answer_2_raw := trim(coalesce(p_answer_2, ''));
    v_answer_1_norm := lower(v_answer_1_raw);
    v_answer_2_norm := lower(v_answer_2_raw);
    v_answer_1_sha256 := encode(digest(v_answer_1_raw, 'sha256'), 'hex');
    v_answer_2_sha256 := encode(digest(v_answer_2_raw, 'sha256'), 'hex');
    v_answer_1_sha256_norm := encode(digest(v_answer_1_norm, 'sha256'), 'hex');
    v_answer_2_sha256_norm := encode(digest(v_answer_2_norm, 'sha256'), 'hex');

    if v_username = '' then
        return json_build_object('success', false, 'error', 'Username is required.');
    end if;

    if p_birthdate is null then
        return json_build_object('success', false, 'error', 'Birthdate is required.');
    end if;

    if length(v_new_password) < 6 then
        return json_build_object('success', false, 'error', 'Password must be at least 6 characters.');
    end if;

    if v_answer_1_raw = '' or v_answer_2_raw = '' then
        return json_build_object('success', false, 'error', 'Both answers are required.');
    end if;

    select u.*
    into v_user
    from public.users u
    where lower(u.username) = lower(v_username)
    limit 1;

    if not found then
        return json_build_object('success', false, 'error', 'Username not found.');
    end if;

    if v_user.birthdate is null or v_user.birthdate <> p_birthdate then
        return json_build_object('success', false, 'error', 'Identity verification failed.');
    end if;

    v_answer_1_ok :=
        (
            coalesce(v_user.security_answer_1_hash, '') <> ''
            and (
                (left(v_user.security_answer_1_hash, 3) in ('$2a', '$2b', '$2y')
                    and v_user.security_answer_1_hash = crypt(v_answer_1_raw, v_user.security_answer_1_hash))
                or
                (lower(v_user.security_answer_1_hash) ~ '^[0-9a-f]{64}$'
                    and lower(v_user.security_answer_1_hash) in (v_answer_1_sha256, v_answer_1_sha256_norm))
                or
                (lower(v_user.security_answer_1_hash) ~ '^[0-9a-f]{32}$'
                    and lower(v_user.security_answer_1_hash) in (md5(v_answer_1_raw), md5(v_answer_1_norm)))
            )
        )
        or (coalesce(trim(v_user.security_answer_1), '') <> '' and lower(trim(v_user.security_answer_1)) = v_answer_1_norm)
        or (coalesce(trim(v_user.secret_answer_1), '') <> '' and lower(trim(v_user.secret_answer_1)) = v_answer_1_norm);

    v_answer_2_ok :=
        (
            coalesce(v_user.security_answer_2_hash, '') <> ''
            and (
                (left(v_user.security_answer_2_hash, 3) in ('$2a', '$2b', '$2y')
                    and v_user.security_answer_2_hash = crypt(v_answer_2_raw, v_user.security_answer_2_hash))
                or
                (lower(v_user.security_answer_2_hash) ~ '^[0-9a-f]{64}$'
                    and lower(v_user.security_answer_2_hash) in (v_answer_2_sha256, v_answer_2_sha256_norm))
                or
                (lower(v_user.security_answer_2_hash) ~ '^[0-9a-f]{32}$'
                    and lower(v_user.security_answer_2_hash) in (md5(v_answer_2_raw), md5(v_answer_2_norm)))
            )
        )
        or (coalesce(trim(v_user.security_answer_2), '') <> '' and lower(trim(v_user.security_answer_2)) = v_answer_2_norm)
        or (coalesce(trim(v_user.secret_answer_2), '') <> '' and lower(trim(v_user.secret_answer_2)) = v_answer_2_norm);

    if not (coalesce(v_answer_1_ok, false) and coalesce(v_answer_2_ok, false)) then
        return json_build_object('success', false, 'error', 'Security answer verification failed.');
    end if;

    update public.users
    set
        password_hash = encode(digest(v_new_password, 'sha256'), 'hex'),
        updated_at = now(),
        last_active = now()
    where id = v_user.id;

    return json_build_object('success', true);
end;
$$;

grant execute on function public.custom_recovery_reset_password(text, date, text, text, text) to anon, authenticated;
