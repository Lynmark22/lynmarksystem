-- ==================================================
-- PUBLIC TENANT LOCATION NAMES RPC
-- Allows unauthenticated (anon) users to fetch room
-- names for the registration dropdown suggestions.
-- Runs with security definer to bypass RLS.
-- Run this in Supabase SQL Editor
-- ==================================================

create or replace function public.get_tenant_location_names()
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_rooms json;
begin
    select coalesce(json_agg(json_build_object(
        'name', trim(name),
        'category', coalesce(nullif(trim(category), ''), 'Door')
    ) order by trim(name)), '[]'::json)
    into v_rooms
    from (
        select distinct on (lower(trim(name))) name, category
        from public.tenant_locations
        where name is not null and trim(name) != ''
        order by lower(trim(name)), created_at desc
    ) sub;

    return json_build_object('success', true, 'rooms', v_rooms);
end;
$$;

grant execute on function public.get_tenant_location_names() to anon;
