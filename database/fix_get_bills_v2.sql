-- ==================================================
-- FIX V2: "Could not choose the best candidate function"
-- ==================================================
-- This error happens because 'get_bills' exists with multiple signatures (e.g., one taking text, one taking uuid).
-- We will DROP ALL variations and recreate the correct one.

-- 1. Drop existing functions to remove ambiguity
DROP FUNCTION IF EXISTS get_bills(text);
DROP FUNCTION IF EXISTS get_bills(uuid);

-- 2. Recreate the correct function
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
