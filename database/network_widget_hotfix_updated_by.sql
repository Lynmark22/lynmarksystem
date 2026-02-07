-- =========================================================
-- HOTFIX: RPC 409 conflict on admin_update/admin_upsert
-- Reason:
-- updated_by foreign key points to auth.users.id, while
-- p_admin_user_id comes from custom billing login.
-- =========================================================

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
