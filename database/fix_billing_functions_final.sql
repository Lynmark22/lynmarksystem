-- ==================================================
-- FINAL FIX: NUCLEAR OPTION FOR BILLING FUNCTIONS
-- ==================================================
-- This script dynamically finds and DROPS ALL versions of 'upsert_bill' and 'delete_bill'
-- regardless of their parameters. This ensures no ambiguity remains.

DO $$ 
DECLARE
    r RECORD;
BEGIN
    -- 1. Drop ALL 'upsert_bill' functions
    FOR r IN (SELECT oid, proname FROM pg_proc WHERE proname = 'upsert_bill' AND pronamespace = 'public'::regnamespace) LOOP
        EXECUTE 'DROP FUNCTION public.' || quote_ident(r.proname) || '(' || pg_get_function_identity_arguments(r.oid) || ')';
    END LOOP;

    -- 2. Drop ALL 'delete_bill' functions
    FOR r IN (SELECT oid, proname FROM pg_proc WHERE proname = 'delete_bill' AND pronamespace = 'public'::regnamespace) LOOP
        EXECUTE 'DROP FUNCTION public.' || quote_ident(r.proname) || '(' || pg_get_function_identity_arguments(r.oid) || ')';
    END LOOP;
    
    -- 3. Drop ALL 'get_bills' functions (Just to be safe)
    FOR r IN (SELECT oid, proname FROM pg_proc WHERE proname = 'get_bills' AND pronamespace = 'public'::regnamespace) LOOP
        EXECUTE 'DROP FUNCTION public.' || quote_ident(r.proname) || '(' || pg_get_function_identity_arguments(r.oid) || ')';
    END LOOP;
END $$;

-- ==================================================
-- RECREATE FUNCTIONS (Clean Slate)
-- ==================================================

-- 1. GET BILLS
CREATE OR REPLACE FUNCTION get_bills(p_user_id uuid)
RETURNS TABLE (
    id uuid,
    room_no text,
    month date,
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

-- 2. UPSERT BILL (Save/Edit)
CREATE OR REPLACE FUNCTION upsert_bill(
    p_user_id uuid,
    p_id uuid,
    p_room_no text,
    p_month date,
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
        INSERT INTO bills (room_no, month, previous_reading, current_reading, rate, amount, status, user_id)
        VALUES (p_room_no, p_month, p_previous_reading, p_current_reading, p_rate, v_amount, p_status, p_user_id)
        RETURNING id INTO v_new_id;
    ELSE
        -- Update
        UPDATE bills
        SET 
            room_no = p_room_no,
            month = p_month,
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

-- 3. DELETE BILL
CREATE OR REPLACE FUNCTION delete_bill(p_user_id uuid, p_bill_id uuid)
RETURNS json
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM bills WHERE id = p_bill_id;
    RETURN json_build_object('success', true);
END;
$$;
