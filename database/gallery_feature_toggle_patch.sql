-- ==================================================
-- GALLERY FEATURE TOGGLE PATCH
-- Adds admin toggle to enable/disable Lynmark Gallery
-- Run this in Supabase SQL Editor
-- ==================================================

-- 1. Add gallery_enabled column to payment_settings
ALTER TABLE public.payment_settings ADD COLUMN IF NOT EXISTS gallery_enabled BOOLEAN DEFAULT TRUE;

-- 2. Update get_payment_settings to include gallery_enabled
DROP FUNCTION IF EXISTS get_payment_settings();
CREATE OR REPLACE FUNCTION get_payment_settings()
RETURNS TABLE (
    id UUID,
    gcash_number TEXT,
    gcash_account_name TEXT,
    gcash_qr_url TEXT,
    payment_instructions TEXT,
    gallery_enabled BOOLEAN,
    updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT 
        id,
        gcash_number,
        gcash_account_name,
        gcash_qr_url,
        payment_instructions,
        gallery_enabled,
        updated_at
    FROM public.payment_settings
    ORDER BY updated_at DESC
    LIMIT 1;
$$;

-- Re-grant execute (signature unchanged)
GRANT EXECUTE ON FUNCTION get_payment_settings() TO anon;

-- 3. Create a lightweight function to toggle gallery alone
CREATE OR REPLACE FUNCTION update_gallery_enabled(
    p_enabled BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_id UUID;
BEGIN
    SELECT id INTO existing_id FROM public.payment_settings LIMIT 1;
    
    IF existing_id IS NOT NULL THEN
        UPDATE public.payment_settings
        SET gallery_enabled = p_enabled, updated_at = now()
        WHERE id = existing_id;
    ELSE
        INSERT INTO public.payment_settings (gcash_number, gcash_account_name, gallery_enabled)
        VALUES ('', '', p_enabled);
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION update_gallery_enabled(BOOLEAN) TO authenticated;

-- 4. Update upsert_payment_settings to include gallery_enabled
DROP FUNCTION IF EXISTS upsert_payment_settings(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS upsert_payment_settings(TEXT, TEXT, TEXT, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION upsert_payment_settings(
    p_gcash_number TEXT,
    p_gcash_account_name TEXT,
    p_gcash_qr_url TEXT DEFAULT NULL,
    p_payment_instructions TEXT DEFAULT NULL,
    p_gallery_enabled BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_id UUID;
BEGIN
    SELECT id INTO existing_id FROM public.payment_settings LIMIT 1;
    
    IF existing_id IS NOT NULL THEN
        UPDATE public.payment_settings
        SET 
            gcash_number = p_gcash_number,
            gcash_account_name = p_gcash_account_name,
            gcash_qr_url = COALESCE(p_gcash_qr_url, gcash_qr_url),
            payment_instructions = p_payment_instructions,
            gallery_enabled = COALESCE(p_gallery_enabled, gallery_enabled),
            updated_at = now()
        WHERE id = existing_id;
    ELSE
        INSERT INTO public.payment_settings (
            gcash_number,
            gcash_account_name,
            gcash_qr_url,
            payment_instructions,
            gallery_enabled
        ) VALUES (
            p_gcash_number,
            p_gcash_account_name,
            p_gcash_qr_url,
            p_payment_instructions,
            COALESCE(p_gallery_enabled, TRUE)
        );
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_payment_settings(TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
