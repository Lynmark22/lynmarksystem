-- =========================================================
-- LYNMARK GALLERY SETUP
-- React gallery page + Supabase Storage metadata backend
-- Run this in Supabase SQL Editor before using gallery.html
-- Run database/setup_security_rate_limits.sql first for anti-abuse checks
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.gallery_photos (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid references public.users(id) on delete set null,
    bucket_name text not null default 'lynmark-gallery',
    storage_path text not null unique,
    caption text,
    taken_at timestamptz not null default now(),
    width integer,
    height integer,
    dominant_color text,
    is_featured boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz
);

create index if not exists idx_gallery_photos_live_timeline
    on public.gallery_photos (taken_at desc, created_at desc)
    where archived_at is null;

create index if not exists idx_gallery_photos_live_owner
    on public.gallery_photos (owner_user_id, created_at desc)
    where archived_at is null;

alter table public.gallery_photos enable row level security;

drop policy if exists gallery_public_read on public.gallery_photos;
create policy gallery_public_read
on public.gallery_photos
for select
using (archived_at is null);

create or replace function public.gallery_photos_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_gallery_photos_set_updated_at on public.gallery_photos;
create trigger trg_gallery_photos_set_updated_at
before update on public.gallery_photos
for each row
execute function public.gallery_photos_set_updated_at();

create or replace function public.gallery_is_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
begin
    if p_user_id is null then
        return false;
    end if;

    begin
        if exists (
            select 1
            from public.app_admins a
            where a.user_id = p_user_id
        ) then
            return true;
        end if;
    exception
        when undefined_table then
            null;
    end;

    begin
        select lower(coalesce(u.role::text, ''))
        into v_role
        from public.users u
        where u.id = p_user_id
        limit 1;
    exception
        when undefined_table or undefined_column then
            v_role := null;
    end;

    return v_role = 'admin';
end;
$$;

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

create or replace function public.gallery_create_photo(
    p_actor_user_id uuid,
    p_bucket_name text,
    p_storage_path text,
    p_caption text default null,
    p_taken_at timestamptz default null,
    p_width integer default null,
    p_height integer default null,
    p_dominant_color text default null
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

create or replace function public.gallery_delete_photo(
    p_actor_user_id uuid,
    p_photo_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner_user_id uuid;
    v_rate_limit jsonb;
begin
    if p_actor_user_id is null then
        raise exception 'A signed-in Lynmark account is required to delete.';
    end if;

    begin
        v_rate_limit := public.security_check_rate_limit(
            'gallery_delete_photo',
            public.security_request_subject(format('gallery-delete:%s', p_actor_user_id)),
            25,
            600,
            1800,
            jsonb_build_object('action', 'gallery_delete_photo')
        );

        if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
            raise exception 'Too many gallery delete attempts from this network. Please wait before trying again.';
        end if;
    exception
        when undefined_function then
            v_rate_limit := null;
    end;

    select gp.owner_user_id
    into v_owner_user_id
    from public.gallery_photos gp
    where gp.id = p_photo_id
      and gp.archived_at is null
    limit 1;

    if not found then
        raise exception 'Photo not found.';
    end if;

    if p_actor_user_id <> v_owner_user_id and not public.gallery_is_admin(p_actor_user_id) then
        raise exception 'You are not allowed to delete this photo.';
    end if;

    delete from public.gallery_photos
    where id = p_photo_id;

    return true;
end;
$$;

create or replace function public.gallery_set_photo_featured(
    p_actor_user_id uuid,
    p_photo_id uuid,
    p_is_featured boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner_user_id uuid;
    v_rate_limit jsonb;
begin
    if p_actor_user_id is null then
        raise exception 'A signed-in Lynmark account is required to manage slideshow pins.';
    end if;

    begin
        v_rate_limit := public.security_check_rate_limit(
            'gallery_set_photo_featured',
            public.security_request_subject(format('gallery-feature:%s', p_actor_user_id)),
            40,
            600,
            1800,
            jsonb_build_object(
                'photo_id', p_photo_id,
                'action', 'gallery_set_photo_featured'
            )
        );

        if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
            raise exception 'Too many slideshow pin changes from this network. Please wait before trying again.';
        end if;
    exception
        when undefined_function then
            v_rate_limit := null;
    end;

    select gp.owner_user_id
    into v_owner_user_id
    from public.gallery_photos gp
    where gp.id = p_photo_id
      and gp.archived_at is null
    limit 1;

    if not found then
        raise exception 'Photo not found.';
    end if;

    if p_actor_user_id <> v_owner_user_id and not public.gallery_is_admin(p_actor_user_id) then
        raise exception 'You are not allowed to change this slideshow pin.';
    end if;

    update public.gallery_photos
    set is_featured = coalesce(p_is_featured, true)
    where id = p_photo_id;

    return true;
end;
$$;

grant execute on function public.gallery_is_admin(uuid) to anon, authenticated;
grant execute on function public.gallery_list_photos(integer, integer) to anon, authenticated;
grant execute on function public.gallery_create_photo(uuid, text, text, text, timestamptz, integer, integer, text) to anon, authenticated;
grant execute on function public.gallery_delete_photo(uuid, uuid) to anon, authenticated;
grant execute on function public.gallery_set_photo_featured(uuid, uuid, boolean) to anon, authenticated;

grant select on public.gallery_photos to anon, authenticated;

-- =========================================================
-- STORAGE BUCKET
-- Files stay in Supabase Storage while Postgres stores
-- the timeline metadata for the React gallery.
--
-- Because this project uses a custom localStorage session instead
-- of Supabase Auth, the storage policies below are intentionally
-- broad so the browser can upload/delete gallery media with the anon key.
-- For stricter security later, move uploads behind an Edge Function
-- or switch the site to Supabase Auth.
-- =========================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'lynmark-gallery',
    'lynmark-gallery',
    true,
    52428800,
    array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'image/gif',
        'video/mp4',
        'video/webm',
        'video/ogg',
        'video/quicktime',
        'video/x-m4v'
    ]
)
on conflict (id) do update
set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gallery_assets_public_read on storage.objects;
create policy gallery_assets_public_read
on storage.objects
for select
using (bucket_id = 'lynmark-gallery');

drop policy if exists gallery_assets_public_insert on storage.objects;
create policy gallery_assets_public_insert
on storage.objects
for insert
with check (bucket_id = 'lynmark-gallery');

drop policy if exists gallery_assets_public_update on storage.objects;
create policy gallery_assets_public_update
on storage.objects
for update
using (bucket_id = 'lynmark-gallery')
with check (bucket_id = 'lynmark-gallery');

drop policy if exists gallery_assets_public_delete on storage.objects;
create policy gallery_assets_public_delete
on storage.objects
for delete
using (bucket_id = 'lynmark-gallery');
