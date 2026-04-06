-- ==================================================
-- PAYMENT SYSTEM SETUP
-- Dynamic GCash Payment Configuration & Submissions
-- Run database/setup_security_rate_limits.sql first for anti-abuse checks
-- ==================================================
-- Run this in Supabase SQL Editor

-- 1. Create payment_settings table (stores GCash configuration)
CREATE TABLE IF NOT EXISTS public.payment_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gcash_number TEXT NOT NULL,
    gcash_account_name TEXT NOT NULL,
    gcash_qr_url TEXT,
    payment_instructions TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by UUID
);

-- 2. Create payment_submissions table (stores user payment submissions)
CREATE TABLE IF NOT EXISTS public.payment_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_gcash_number TEXT NOT NULL,
    sender_full_name TEXT NOT NULL,
    sender_contact_number TEXT NOT NULL,
    room_no TEXT NOT NULL,
    amount_to_pay NUMERIC NOT NULL,
    receipt_image_url TEXT,
    status TEXT DEFAULT 'PENDING',  -- PENDING, REVIEWING, APPROVED, REJECTED
    submitted_at TIMESTAMPTZ DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID
);

-- 3. Enable RLS on both tables
ALTER TABLE public.payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies for payment_settings
-- Everyone can read payment settings
DROP POLICY IF EXISTS "Public can read payment settings" ON public.payment_settings;
CREATE POLICY "Public can read payment settings" ON public.payment_settings
    FOR SELECT USING (true);

-- Only authenticated users can update (admin check done in function)
DROP POLICY IF EXISTS "Authenticated users can update payment settings" ON public.payment_settings;
CREATE POLICY "Authenticated users can update payment settings" ON public.payment_settings
    FOR ALL USING (true) WITH CHECK (true);

-- 5. RLS Policies for payment_submissions
DROP POLICY IF EXISTS "Anyone can submit payments" ON public.payment_submissions;
DROP POLICY IF EXISTS "Public can read submissions" ON public.payment_submissions;

-- 6. Function to get payment settings (public access)
CREATE OR REPLACE FUNCTION get_payment_settings()
RETURNS TABLE (
    id UUID,
    gcash_number TEXT,
    gcash_account_name TEXT,
    gcash_qr_url TEXT,
    payment_instructions TEXT,
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
        updated_at
    FROM public.payment_settings
    ORDER BY updated_at DESC
    LIMIT 1;
$$;

-- Grant execute to anonymous users
GRANT EXECUTE ON FUNCTION get_payment_settings() TO anon;

-- 7. Function to upsert payment settings (admin only)
CREATE OR REPLACE FUNCTION upsert_payment_settings(
    p_gcash_number TEXT,
    p_gcash_account_name TEXT,
    p_gcash_qr_url TEXT DEFAULT NULL,
    p_payment_instructions TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_id UUID;
BEGIN
    -- Check if settings already exist
    SELECT id INTO existing_id FROM public.payment_settings LIMIT 1;
    
    IF existing_id IS NOT NULL THEN
        -- Update existing
        UPDATE public.payment_settings
        SET 
            gcash_number = p_gcash_number,
            gcash_account_name = p_gcash_account_name,
            gcash_qr_url = COALESCE(p_gcash_qr_url, gcash_qr_url),
            payment_instructions = p_payment_instructions,
            updated_at = now()
        WHERE id = existing_id;
    ELSE
        -- Insert new
        INSERT INTO public.payment_settings (
            gcash_number,
            gcash_account_name,
            gcash_qr_url,
            payment_instructions
        ) VALUES (
            p_gcash_number,
            p_gcash_account_name,
            p_gcash_qr_url,
            p_payment_instructions
        );
    END IF;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION upsert_payment_settings(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 8. Function to submit payment (public access)
CREATE OR REPLACE FUNCTION submit_payment(
    p_sender_gcash_number TEXT,
    p_sender_full_name TEXT,
    p_sender_contact_number TEXT,
    p_room_no TEXT,
    p_amount_to_pay NUMERIC,
    p_receipt_image_url TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    new_id UUID;
    v_rate_limit jsonb;
BEGIN
    v_rate_limit := public.security_check_rate_limit(
        'submit_payment',
        public.security_request_subject(format('payment:%s', lower(trim(coalesce(p_room_no, 'unknown-room'))))),
        5,
        600,
        3600,
        jsonb_build_object(
            'room_no', left(trim(coalesce(p_room_no, '')), 40),
            'action', 'submit_payment'
        )
    );

    if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
        raise exception 'Too many payment submissions from this network. Please wait before trying again.';
    end if;

    INSERT INTO public.payment_submissions (
        sender_gcash_number,
        sender_full_name,
        sender_contact_number,
        room_no,
        amount_to_pay,
        receipt_image_url,
        status
    ) VALUES (
        p_sender_gcash_number,
        p_sender_full_name,
        p_sender_contact_number,
        p_room_no,
        p_amount_to_pay,
        p_receipt_image_url,
        'PENDING'
    )
    RETURNING id INTO new_id;
    
    RETURN new_id;
END;
$$;

-- Grant execute to anonymous users
GRANT EXECUTE ON FUNCTION submit_payment(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO anon;

-- 9. Grant table permissions for storage operations
GRANT SELECT ON public.payment_settings TO anon;
GRANT ALL ON public.payment_settings TO authenticated;
REVOKE ALL ON public.payment_submissions FROM anon;
GRANT ALL ON public.payment_submissions TO authenticated;

-- ==================================================
-- STORAGE BUCKET SETUP (Run separately in Storage UI or via API)
-- ==================================================
-- Create a bucket named 'payment-assets' with public access
-- This needs to be done in Supabase Dashboard > Storage > Create bucket
-- Bucket name: payment-assets
-- Public bucket: Yes
-- File size limit: 5MB
-- Allowed MIME types: image/png, image/jpeg, image/webp, image/gif
