-- ==================================================
-- PAYMENT SYSTEM SETUP
-- Dynamic GCash Payment Configuration & Submissions
-- Run database/setup_security_rate_limits.sql first for anti-abuse checks
-- Run database/setup_shared_users_create_account.sql before this if you want
-- login-required payment submissions via submit_payment_authenticated().
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
    submitted_by_user_id UUID,
    submitted_by_username TEXT,
    status TEXT DEFAULT 'PENDING',  -- PENDING, REVIEWING, APPROVED, REJECTED
    submitted_at TIMESTAMPTZ DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID
);

ALTER TABLE public.payment_submissions ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID;
ALTER TABLE public.payment_submissions ADD COLUMN IF NOT EXISTS submitted_by_username TEXT;

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

-- 8. Function to submit payment (requires valid custom login session)
CREATE OR REPLACE FUNCTION submit_payment_authenticated(
    p_session_token TEXT,
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
    v_user public.users%rowtype;
    v_session public.user_sessions%rowtype;
    v_token_hash text;
    v_room_no text;
    v_account_room text;
BEGIN
    v_room_no := trim(coalesce(p_room_no, ''));

    if trim(coalesce(p_session_token, '')) = '' then
        raise exception 'Sign in is required before submitting payment.';
    end if;

    if trim(coalesce(p_sender_gcash_number, '')) = ''
        or trim(coalesce(p_sender_full_name, '')) = ''
        or trim(coalesce(p_sender_contact_number, '')) = ''
        or v_room_no = '' then
        raise exception 'All payment fields are required.';
    end if;

    if p_amount_to_pay is null or p_amount_to_pay <= 0 then
        raise exception 'Payment amount must be greater than zero.';
    end if;

    v_token_hash := encode(digest(trim(p_session_token), 'sha256'), 'hex');

    select s.*
    into v_session
    from public.user_sessions s
    where s.session_token_hash = v_token_hash
      and s.app_context = 'billing'
      and s.revoked_at is null
    order by s.created_at desc
    limit 1;

    if not found or v_session.expires_at <= now() then
        raise exception 'Your session expired. Please sign in again.';
    end if;

    select u.*
    into v_user
    from public.users u
    where u.id = v_session.user_id
    limit 1;

    if not found then
        raise exception 'Account not found. Please sign in again.';
    end if;

    if coalesce(v_user.is_blocked, false) then
        raise exception 'This account is blocked. Please contact admin.';
    end if;

    if v_user.restricted_until is not null and v_user.restricted_until > now() then
        raise exception 'This account is temporarily restricted.';
    end if;

    v_account_room := trim(coalesce(v_user.tenant_location, ''));
    if v_account_room <> '' and lower(v_account_room) <> lower(v_room_no) then
        raise exception 'This account can only submit payment for room %.', v_account_room;
    end if;

    v_rate_limit := public.security_check_rate_limit(
        'submit_payment_authenticated',
        public.security_request_subject(format('payment:%s:%s', v_user.id::text, lower(v_room_no))),
        5,
        600,
        3600,
        jsonb_build_object(
            'room_no', left(v_room_no, 40),
            'action', 'submit_payment_authenticated',
            'user_id', v_user.id::text
        )
    );

    if not coalesce((v_rate_limit ->> 'allowed')::boolean, false) then
        raise exception 'Too many payment submissions from this network. Please wait before trying again.';
    end if;

    update public.user_sessions
    set last_seen_at = now()
    where id = v_session.id;

    update public.users
    set last_active = now(),
        updated_at = now()
    where id = v_user.id;

    INSERT INTO public.payment_submissions (
        sender_gcash_number,
        sender_full_name,
        sender_contact_number,
        room_no,
        amount_to_pay,
        receipt_image_url,
        submitted_by_user_id,
        submitted_by_username,
        status
    ) VALUES (
        trim(p_sender_gcash_number),
        trim(p_sender_full_name),
        trim(p_sender_contact_number),
        v_room_no,
        p_amount_to_pay,
        nullif(trim(coalesce(p_receipt_image_url, '')), ''),
        v_user.id,
        v_user.username,
        'PENDING'
    )
    RETURNING id INTO new_id;

    RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_payment_authenticated(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO anon, authenticated;

DO $$
BEGIN
    REVOKE EXECUTE ON FUNCTION submit_payment(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM anon, authenticated;
EXCEPTION
    WHEN undefined_function THEN
        NULL;
END;
$$;

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
