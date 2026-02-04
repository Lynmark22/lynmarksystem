-- ==================================================
-- UPDATE: BILLING PERIOD RANGE (Start - End)
-- ==================================================

-- 1. Add new columns for the period range
ALTER TABLE public.bills 
ADD COLUMN IF NOT EXISTS period_start date,
ADD COLUMN IF NOT EXISTS period_end date;

-- 2. NUCLEAR DROP: Remove existing functions to prevent signature conflicts
DO $$ 
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT oid, proname FROM pg_proc WHERE proname IN ('get_bills', 'upsert_bill') AND pronamespace = 'public'::regnamespace) LOOP
        EXECUTE 'DROP FUNCTION public.' || quote_ident(r.proname) || '(' || pg_get_function_identity_arguments(r.oid) || ')';
    END LOOP;
END $$;

-- 3. RECREATE functions with new columns

-- GET BILLS (Now returns period_start and period_end)
CREATE OR REPLACE FUNCTION get_bills(p_user_id uuid)
RETURNS TABLE (
    id uuid,
    room_no text,
    month date, -- Kept for sorting/legacy
    period_start date,
    period_end date,
    previous_reading numeric,
    current_reading numeric,
    rate numeric,
    amount numeric,
    status text,
    kwh_used numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        b.id,
        b.room_no,
        b.month,
        b.period_start,
        b.period_end,
        b.previous_reading,
        b.current_reading,
        b.rate,
        b.amount,
        b.status,
        (b.current_reading - b.previous_reading) as kwh_used
    FROM bills b
    ORDER BY b.month DESC, b.id ASC;
END;
$$;

-- UPSERT BILL (Now accepts period_start and period_end)
CREATE OR REPLACE FUNCTION upsert_bill(
    p_user_id uuid,
    p_id uuid,
    p_room_no text,
    p_month date, -- We will set this to period_end usually
    p_period_start date,
    p_period_end date,
    p_previous_reading numeric,
    p_current_reading numeric,
    p_rate numeric,
    p_status text
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
    v_amount numeric;
    v_new_id uuid;
BEGIN
    -- Calculate Amount
    v_amount := (p_current_reading - p_previous_reading) * p_rate;

    IF p_id IS NULL THEN
        -- Insert
        INSERT INTO bills (room_no, month, period_start, period_end, previous_reading, current_reading, rate, amount, status, user_id)
        VALUES (p_room_no, p_month, p_period_start, p_period_end, p_previous_reading, p_current_reading, p_rate, v_amount, p_status, p_user_id)
        RETURNING id INTO v_new_id;
    ELSE
        -- Update
        UPDATE bills
        SET 
            room_no = p_room_no,
            month = p_month,
            period_start = p_period_start,
            period_end = p_period_end,
            previous_reading = p_previous_reading,
            current_reading = p_current_reading,
            rate = p_rate,
            amount = v_amount,
            status = p_status,
            user_id = p_user_id
        WHERE id = p_id;
        v_new_id := p_id;
    END IF;

    RETURN json_build_object('success', true, 'id', v_new_id);
END;
$$;
