-- ==================================================
-- NETWORK WIDGET CUSTOM ACCENT PATCH
-- Adds persisted custom accent config for upgrade tiers.
-- Run this once in Supabase SQL editor.
-- ==================================================

alter table public.upgrade_offers
    add column if not exists accent_config jsonb;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'upgrade_offers_accent_config_valid'
          and conrelid = 'public.upgrade_offers'::regclass
    ) then
        alter table public.upgrade_offers
            add constraint upgrade_offers_accent_config_valid
            check (
                accent_config is null
                or (
                    jsonb_typeof(accent_config) = 'object'
                    and coalesce(accent_config->>'mode', '') in ('solid', 'gradient')
                )
            );
    end if;
end $$;

update public.upgrade_offers
set accent_config = jsonb_build_object(
    'mode', 'gradient',
    'solidColor', '#4f8cff',
    'gradientStart', '#4f8cff',
    'gradientEnd', '#3768d9'
)
where accent = 'custom'
  and accent_config is null;

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
                        'accent_config', u.accent_config,
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

drop function if exists public.admin_get_upgrade_offers(uuid);

create or replace function public.admin_get_upgrade_offers(p_admin_user_id uuid)
returns table (
    id uuid,
    label text,
    slug text,
    cta_url text,
    status text,
    accent text,
    accent_config jsonb,
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
        u.accent_config,
        u.is_visible,
        u.sort_order,
        u.updated_at
    from public.upgrade_offers u
    order by u.sort_order, u.created_at;
end;
$$;

grant execute on function public.admin_get_upgrade_offers(uuid) to anon, authenticated;

drop function if exists public.admin_set_upgrade_accent_config(uuid, jsonb, uuid);

create or replace function public.admin_set_upgrade_accent_config(
    p_id uuid,
    p_accent_config jsonb,
    p_admin_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_updated_by uuid;
    v_mode text;
    v_solid text;
    v_gradient_start text;
    v_gradient_end text;
    v_normalized jsonb;
begin
    if not public.network_widget_is_admin(p_admin_user_id) then
        raise exception 'not_authorized';
    end if;

    v_updated_by := public.network_widget_resolve_auth_user(p_admin_user_id);

    if p_accent_config is null then
        update public.upgrade_offers
        set accent_config = null,
            updated_at = now(),
            updated_by = v_updated_by
        where id = p_id;
        return;
    end if;

    if jsonb_typeof(p_accent_config) <> 'object' then
        raise exception 'invalid_accent_config';
    end if;

    v_mode := lower(coalesce(p_accent_config->>'mode', 'gradient'));
    if v_mode not in ('solid', 'gradient') then
        v_mode := 'gradient';
    end if;

    v_solid := lower(coalesce(p_accent_config->>'solidColor', '#4f8cff'));
    v_gradient_start := lower(coalesce(p_accent_config->>'gradientStart', '#4f8cff'));
    v_gradient_end := lower(coalesce(p_accent_config->>'gradientEnd', '#3768d9'));

    if v_solid !~ '^#[0-9a-f]{6}$' then v_solid := '#4f8cff'; end if;
    if v_gradient_start !~ '^#[0-9a-f]{6}$' then v_gradient_start := '#4f8cff'; end if;
    if v_gradient_end !~ '^#[0-9a-f]{6}$' then v_gradient_end := '#3768d9'; end if;

    v_normalized := jsonb_build_object(
        'mode', v_mode,
        'solidColor', v_solid,
        'gradientStart', v_gradient_start,
        'gradientEnd', v_gradient_end
    );

    update public.upgrade_offers
    set accent_config = v_normalized,
        updated_at = now(),
        updated_by = v_updated_by
    where id = p_id;
end;
$$;

grant execute on function public.admin_set_upgrade_accent_config(uuid, jsonb, uuid) to anon, authenticated;
