-- =========================================================
-- NETWORK WIDGET ADMIN PATCH (Billing Admin ID based)
-- Use this when admin tools are accessed from index.html
-- via localStorage billing_user session (custom_login flow).
-- =========================================================

create extension if not exists pgcrypto;

create table if not exists public.app_admins (
    user_id uuid primary key,
    created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

drop policy if exists app_admins_read_all on public.app_admins;
create policy app_admins_read_all
on public.app_admins
for select
using (true);

create or replace function public.network_widget_is_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_is_admin boolean;
begin
    if p_user_id is null then
        return false;
    end if;

    -- Explicit allow-list (recommended)
    if exists (select 1 from public.app_admins a where a.user_id = p_user_id) then
        return true;
    end if;

    -- Try common app user tables used by custom_login setups.
    begin
        execute 'select role::text from public.users where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    begin
        execute 'select role::text from public.billing_users where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    begin
        execute 'select role::text from public.user_profiles where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    -- Additional common schemas/column names
    begin
        execute 'select user_role::text from public.users where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    begin
        execute 'select role::text from public.profiles where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    begin
        execute 'select role::text from public.profiles where user_id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    begin
        execute 'select user_role::text from public.user_profiles where id = $1 limit 1'
        into v_role
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_role := null;
    end;

    if lower(coalesce(v_role, '')) = 'admin' then
        return true;
    end if;

    -- Boolean admin flags
    begin
        execute 'select is_admin from public.users where id = $1 limit 1'
        into v_is_admin
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_is_admin := null;
    end;

    if coalesce(v_is_admin, false) then
        return true;
    end if;

    begin
        execute 'select is_admin from public.billing_users where id = $1 limit 1'
        into v_is_admin
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_is_admin := null;
    end;

    if coalesce(v_is_admin, false) then
        return true;
    end if;

    begin
        execute 'select is_admin from public.user_profiles where id = $1 limit 1'
        into v_is_admin
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_is_admin := null;
    end;

    if coalesce(v_is_admin, false) then
        return true;
    end if;

    begin
        execute 'select is_admin from public.profiles where id = $1 limit 1'
        into v_is_admin
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_is_admin := null;
    end;

    if coalesce(v_is_admin, false) then
        return true;
    end if;

    begin
        execute 'select is_admin from public.profiles where user_id = $1 limit 1'
        into v_is_admin
        using p_user_id;
    exception when undefined_table or undefined_column then
        v_is_admin := null;
    end;

    if coalesce(v_is_admin, false) then
        return true;
    end if;

    return false;
end;
$$;

grant execute on function public.network_widget_is_admin(uuid) to anon, authenticated;

create or replace function public.network_widget_resolve_auth_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_auth_user_id uuid;
begin
    if p_user_id is null then
        return null;
    end if;

    begin
        select u.id
        into v_auth_user_id
        from auth.users u
        where u.id = p_user_id
        limit 1;
    exception when undefined_table then
        v_auth_user_id := null;
    end;

    return v_auth_user_id;
end;
$$;

grant execute on function public.network_widget_resolve_auth_user(uuid) to anon, authenticated;

create table if not exists public.speed_widget_settings (
    id int primary key default 1 check (id = 1),
    download_value numeric(10,2) not null default 1,
    download_unit text not null default 'Mbps' check (download_unit in ('Kbps', 'Mbps', 'Gbps')),
    upload_value numeric(10,2) not null default 800,
    upload_unit text not null default 'Kbps' check (upload_unit in ('Kbps', 'Mbps', 'Gbps')),
    updated_at timestamptz not null default now(),
    updated_by uuid
);

insert into public.speed_widget_settings (
    id,
    download_value,
    download_unit,
    upload_value,
    upload_unit
) values (
    1, 1, 'Mbps', 800, 'Kbps'
)
on conflict (id) do nothing;

create table if not exists public.upgrade_offers (
    id uuid primary key default gen_random_uuid(),
    label text not null,
    slug text not null unique,
    cta_url text not null,
    status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'PAUSED', 'HIDDEN')),
    accent text not null default 'standard' check (accent in ('standard', 'premium', 'custom')),
    is_visible boolean not null default true,
    sort_order int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    updated_by uuid
);

insert into public.upgrade_offers (
    label,
    slug,
    cta_url,
    status,
    accent,
    is_visible,
    sort_order
) values
    ('STANDARD', 'standard', 'https://lmvouchersystem.vercel.app/', 'AVAILABLE', 'standard', true, 10),
    ('PREMIUM', 'premium', 'https://lmvouchersystem.vercel.app/', 'AVAILABLE', 'premium', true, 20)
on conflict (slug) do nothing;

alter table public.speed_widget_settings enable row level security;
alter table public.upgrade_offers enable row level security;

drop policy if exists speed_public_read on public.speed_widget_settings;
create policy speed_public_read
on public.speed_widget_settings
for select
using (true);

drop policy if exists upgrades_public_read_visible on public.upgrade_offers;
create policy upgrades_public_read_visible
on public.upgrade_offers
for select
using (is_visible = true and status <> 'HIDDEN');

grant select on public.speed_widget_settings to anon, authenticated;
grant select on public.upgrade_offers to anon, authenticated;

create or replace function public.get_network_widget_data()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'speed',
        (
            select jsonb_build_object(
                'download_value', s.download_value,
                'download_unit', s.download_unit,
                'upload_value', s.upload_value,
                'upload_unit', s.upload_unit
            )
            from public.speed_widget_settings s
            where s.id = 1
        ),
        'upgrades',
        (
            select coalesce(
                jsonb_agg(
                    jsonb_build_object(
                        'id', u.id,
                        'label', u.label,
                        'slug', u.slug,
                        'cta_url', u.cta_url,
                        'status', u.status,
                        'accent', u.accent,
                        'is_visible', u.is_visible,
                        'sort_order', u.sort_order
                    )
                    order by u.sort_order, u.created_at
                ),
                '[]'::jsonb
            )
            from public.upgrade_offers u
            where u.is_visible = true and u.status <> 'HIDDEN'
        )
    );
$$;

grant execute on function public.get_network_widget_data() to anon, authenticated;

drop function if exists public.admin_update_speed_widget(numeric, text, numeric, text);
drop function if exists public.admin_update_speed_widget(numeric, text, numeric, text, uuid);

create or replace function public.admin_update_speed_widget(
    p_download_value numeric,
    p_download_unit text,
    p_upload_value numeric,
    p_upload_unit text,
    p_admin_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_updated_by uuid;
begin
    if not public.network_widget_is_admin(p_admin_user_id) then
        raise exception 'not_authorized';
    end if;

    v_updated_by := public.network_widget_resolve_auth_user(p_admin_user_id);

    update public.speed_widget_settings
    set download_value = p_download_value,
        download_unit = p_download_unit,
        upload_value = p_upload_value,
        upload_unit = p_upload_unit,
        updated_at = now(),
        updated_by = v_updated_by
    where id = 1;
end;
$$;

grant execute on function public.admin_update_speed_widget(numeric, text, numeric, text, uuid) to anon, authenticated;

drop function if exists public.admin_upsert_upgrade_offer(text, text, text, text, text, boolean, int, uuid);
drop function if exists public.admin_upsert_upgrade_offer(text, text, text, text, text, boolean, int, uuid, uuid);

create or replace function public.admin_upsert_upgrade_offer(
    p_label text,
    p_slug text,
    p_cta_url text,
    p_status text,
    p_accent text,
    p_is_visible boolean,
    p_sort_order int,
    p_id uuid,
    p_admin_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_updated_by uuid;
begin
    if not public.network_widget_is_admin(p_admin_user_id) then
        raise exception 'not_authorized';
    end if;

    v_updated_by := public.network_widget_resolve_auth_user(p_admin_user_id);

    if p_id is null then
        insert into public.upgrade_offers (
            label, slug, cta_url, status, accent, is_visible, sort_order, updated_by
        ) values (
            p_label, p_slug, p_cta_url, p_status, p_accent, p_is_visible, p_sort_order, v_updated_by
        )
        returning id into v_id;
    else
        update public.upgrade_offers
        set label = p_label,
            slug = p_slug,
            cta_url = p_cta_url,
            status = p_status,
            accent = p_accent,
            is_visible = p_is_visible,
            sort_order = p_sort_order,
            updated_at = now(),
            updated_by = v_updated_by
        where id = p_id
        returning id into v_id;
    end if;

    return v_id;
end;
$$;

grant execute on function public.admin_upsert_upgrade_offer(text, text, text, text, text, boolean, int, uuid, uuid) to anon, authenticated;

drop function if exists public.admin_delete_upgrade_offer(uuid, boolean);
drop function if exists public.admin_delete_upgrade_offer(uuid, boolean, uuid);

create or replace function public.admin_delete_upgrade_offer(
    p_id uuid,
    p_hard_delete boolean,
    p_admin_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_updated_by uuid;
begin
    if not public.network_widget_is_admin(p_admin_user_id) then
        raise exception 'not_authorized';
    end if;

    v_updated_by := public.network_widget_resolve_auth_user(p_admin_user_id);

    if p_hard_delete then
        delete from public.upgrade_offers where id = p_id;
    else
        update public.upgrade_offers
        set is_visible = false,
            status = 'HIDDEN',
            updated_at = now(),
            updated_by = v_updated_by
        where id = p_id;
    end if;
end;
$$;

grant execute on function public.admin_delete_upgrade_offer(uuid, boolean, uuid) to anon, authenticated;

create or replace function public.admin_get_upgrade_offers(p_admin_user_id uuid)
returns table (
    id uuid,
    label text,
    slug text,
    cta_url text,
    status text,
    accent text,
    is_visible boolean,
    sort_order int,
    updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.network_widget_is_admin(p_admin_user_id) then
        raise exception 'not_authorized';
    end if;

    return query
    select
        u.id,
        u.label,
        u.slug,
        u.cta_url,
        u.status,
        u.accent,
        u.is_visible,
        u.sort_order,
        u.updated_at
    from public.upgrade_offers u
    order by u.sort_order, u.created_at;
end;
$$;

grant execute on function public.admin_get_upgrade_offers(uuid) to anon, authenticated;

-- Optional: add your known billing admin user id if needed
-- insert into public.app_admins (user_id)
-- values ('PUT-YOUR-BILLING-ADMIN-USER-ID-HERE'::uuid)
-- on conflict do nothing;
