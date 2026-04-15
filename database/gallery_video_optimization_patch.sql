-- =========================================================
-- GALLERY VIDEO OPTIMIZATION PATCH
-- Adds lightweight poster thumbnails and future video quality
-- variant metadata for the gallery.
-- Run this in Supabase SQL Editor for existing deployments.
-- =========================================================

alter table public.gallery_photos
    add column if not exists poster_storage_path text;

alter table public.gallery_photos
    add column if not exists video_variants jsonb not null default '{}'::jsonb;

drop function if exists public.gallery_list_photos(integer, integer);
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
    poster_storage_path text,
    video_variants jsonb,
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
        gp.poster_storage_path,
        coalesce(gp.video_variants, '{}'::jsonb),
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

create or replace function public.gallery_create_photo(
    p_actor_user_id uuid,
    p_bucket_name text,
    p_storage_path text,
    p_caption text default null,
    p_taken_at timestamptz default null,
    p_width integer default null,
    p_height integer default null,
    p_dominant_color text default null,
    p_poster_storage_path text default null,
    p_video_variants jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_photo_id uuid;
    v_rate_limit jsonb;
begin
    if p_actor_user_id is null then
        raise exception 'A signed-in Lynmark account is required to upload.';
    end if;

    begin
        v_rate_limit := public.security_check_rate_limit(
            'gallery_create_photo',
            public.security_request_subject(format('gallery-upload:%s', p_actor_user_id)),
            30,
            600,
            1800,
            jsonb_build_object(
                'bucket_name', coalesce(nullif(trim(p_bucket_name), ''), 'lynmark-gallery'),
                'action', 'gallery_create_photo'
            )
        );

        if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
            raise exception 'Too many gallery upload attempts from this network. Please wait before trying again.';
        end if;
    exception
        when undefined_function then
            v_rate_limit := null;
    end;

    if not exists (
        select 1
        from public.users u
        where u.id = p_actor_user_id
    ) then
        raise exception 'The selected Lynmark account could not be verified.';
    end if;

    if coalesce(trim(p_storage_path), '') = '' then
        raise exception 'Storage path is required.';
    end if;

    insert into public.gallery_photos (
        owner_user_id,
        bucket_name,
        storage_path,
        poster_storage_path,
        video_variants,
        caption,
        taken_at,
        width,
        height,
        dominant_color
    )
    values (
        p_actor_user_id,
        coalesce(nullif(trim(p_bucket_name), ''), 'lynmark-gallery'),
        trim(p_storage_path),
        nullif(trim(coalesce(p_poster_storage_path, '')), ''),
        coalesce(p_video_variants, '{}'::jsonb),
        nullif(trim(coalesce(p_caption, '')), ''),
        coalesce(p_taken_at, now()),
        p_width,
        p_height,
        nullif(trim(coalesce(p_dominant_color, '')), '')
    )
    returning id into v_photo_id;

    return v_photo_id;
end;
$$;

grant execute on function public.gallery_list_photos(integer, integer) to anon, authenticated;
grant execute on function public.gallery_create_photo(uuid, text, text, text, timestamptz, integer, integer, text, text, jsonb) to anon, authenticated;
