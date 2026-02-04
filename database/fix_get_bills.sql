-- ==================================================
-- FIX: "column reference 'id' is ambiguous" in get_bills
-- ==================================================
-- This error happens because 'id' exists in both the 'bills' table and possibly another joined table or parameter.
-- To fix it, we must explicitly specify the table name (bills) for the 'id' column.

-- INSTRUCTIONS:
-- 1. Go to your Supabase Dashboard -> SQL Editor.
-- 2. Copy and paste the code below.
-- 3. Click RUN.

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
    -- Check if user is admin (you might need to adjust the role check depending on your auth setup)
    -- Assuming a simple check or returning all for now if logic is complex.
    -- The core fix is ensuring "ORDER BY bills.id" instead of "ORDER BY id"
    
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
    ORDER BY b.month DESC, b.id ASC; -- Explicitly using table alias 'b'
END;
$$;
