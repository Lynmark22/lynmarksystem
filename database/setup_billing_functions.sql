-- ==================================================
-- FIX: Missing Billing Functions (Upsert & Delete)
-- ==================================================
-- creating the 'bills' table wasn't enough; we need the functions 
-- that the JavaScript calls: 'upsert_bill' and 'delete_bill'.

-- 1. Create UPSERT Function (Add or Edit)
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
    -- Calculate Amount: (Curr - Prev) * Rate
    v_amount := (p_current_reading - p_previous_reading) * p_rate;

    IF p_id IS NULL THEN
        -- Insert New
        INSERT INTO bills (room_no, month, previous_reading, current_reading, rate, amount, status, user_id)
        VALUES (p_room_no, p_month, p_previous_reading, p_current_reading, p_rate, v_amount, p_status, p_user_id)
        RETURNING id INTO v_new_id;
    ELSE
        -- Update Existing
        UPDATE bills
        SET 
            room_no = p_room_no,
            month = p_month,
            previous_reading = p_previous_reading,
            current_reading = p_current_reading,
            rate = p_rate,
            amount = v_amount,
            status = p_status,
            user_id = p_user_id -- optionally update user linkage
        WHERE id = p_id;
        v_new_id := p_id;
    END IF;

    RETURN json_build_object('success', true, 'id', v_new_id);
END;
$$;

-- 2. Create DELETE Function
CREATE OR REPLACE FUNCTION delete_bill(p_user_id uuid, p_bill_id uuid)
RETURNS json
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM bills WHERE id = p_bill_id;
    RETURN json_build_object('success', true);
END;
$$;
