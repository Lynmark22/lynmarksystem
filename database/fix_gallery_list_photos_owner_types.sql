-- =========================================================
-- FIX GALLERY LIST RPC OWNER TYPE MISMATCH
-- Run this in Supabase SQL Editor if gallery_list_photos fails.
-- =========================================================

create or replace function public.gallery_list_photos(
    p_limit integer default 240,
    p_offset integer default 0
)
returns table (
    id uuid,
    owner_user_id uuid,
    owner_name text,
    owner_username text,
    bucket_name text,
    storage_path text,
    caption text,
    taken_at timestamptz,
    width integer,
    height integer,
    dominant_color text,
    is_featured boolean,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_rate_limit jsonb;
begin
    begin
        v_rate_limit := public.security_check_rate_limit(
            'gallery_list_photos',
            public.security_request_subject('gallery-read'),
            120,
            60,
            300,
            jsonb_build_object('action', 'gallery_list_photos')
        );

        if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
            raise exception 'Too many gallery requests from this network. Please wait before refreshing again.';
        end if;
    exception
        when undefined_function then
            v_rate_limit := null;
    end;

    return query
    select
        gp.id,
        gp.owner_user_id,
        coalesce(
            nullif(trim(concat_ws(' ', u.first_name::text, u.last_name::text)), ''),
            nullif(trim(u.username::text), ''),
            'Unknown uploader'
        ) as owner_name,
        u.username::text as owner_username,
        gp.bucket_name,
        gp.storage_path,
        gp.caption,
        gp.taken_at,
        gp.width,
        gp.height,
        gp.dominant_color,
        gp.is_featured,
        gp.created_at
    from public.gallery_photos gp
    left join public.users u
        on u.id = gp.owner_user_id
    where gp.archived_at is null
    order by gp.taken_at desc, gp.created_at desc
    limit greatest(1, least(coalesce(p_limit, 240), 500))
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function public.gallery_list_photos(integer, integer) to anon, authenticated;
