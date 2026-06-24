-- ==================================================
-- PREVENT MULTIPLE ACCOUNTS PATCH
-- Blocks duplicate registration based on:
--   - First name + last name combination
--   - Contact info / phone number
-- Returns generic error to hide detection logic
-- Run this in Supabase SQL Editor
-- ==================================================

create or replace function public.custom_register_user(
    p_username text,
    p_password text,
    p_first_name text,
    p_last_name text,
    p_contact_info text,
    p_birthdate date default null,
    p_tenant_location text default null,
    p_tenant_password text default null,
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
    v_tenant_location text;
    v_tenant_password text;
    v_security_question_1 text;
    v_security_answer_1 text;
    v_security_question_2 text;
    v_security_answer_2 text;
    v_security_question_3 text;
    v_security_answer_3 text;
    v_new_user public.users%rowtype;
    v_location_id uuid;
begin
    v_username := trim(coalesce(p_username, ''));
    v_first_name := trim(coalesce(p_first_name, ''));
    v_last_name := trim(coalesce(p_last_name, ''));
    v_contact_info := trim(coalesce(p_contact_info, ''));
    v_password := coalesce(p_password, '');
    v_tenant_location := trim(coalesce(p_tenant_location, ''));
    v_tenant_password := coalesce(p_tenant_password, '');
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

    -- Check for duplicate first name + last name combination (anti-spam)
    if exists (
        select 1
        from public.users u
        where lower(trim(u.first_name)) = lower(v_first_name)
          and lower(trim(u.last_name)) = lower(v_last_name)
    ) then
        return json_build_object('success', false, 'error', 'No multiple account allowed.');
    end if;

    -- Check for duplicate phone number / contact info (anti-spam)
    if exists (
        select 1
        from public.users u
        where lower(trim(u.contact_info)) = lower(v_contact_info)
    ) then
        return json_build_object('success', false, 'error', 'No multiple account allowed.');
    end if;

    -- Tenant location required
    if v_tenant_location = '' then
        return json_build_object('success', false, 'error', 'Your Door/Room/Residence is required.');
    end if;

    -- Tenant password required
    if v_tenant_password = '' then
        return json_build_object('success', false, 'error', 'Room password is required.');
    end if;

    -- Verify tenant location exists and password matches
    select id into v_location_id
    from public.tenant_locations
    where lower(trim(name)) = lower(v_tenant_location)
      and password = v_tenant_password;

    if v_location_id is null then
        return json_build_object('success', false, 'error', 'Room password is incorrect.');
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
        v_tenant_location
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
        return json_build_object('success', false, 'error', 'No multiple account allowed.');
    when others then
        return json_build_object('success', false, 'error', 'No multiple account allowed.');
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
    text,
    text
) to authenticated;
