-- ==================================================
-- PUBLIC ACCESS: Get Bills Without Authentication
-- ==================================================
-- Run this in Supabase SQL Editor

-- Create a function for public read-only access to billing data
CREATE OR REPLACE FUNCTION get_public_bills()
RETURNS TABLE (
    id UUID,
    room_no TEXT,
    month DATE,
    period_start DATE,
    period_end DATE,
    previous_reading NUMERIC,
    current_reading NUMERIC,
    rate NUMERIC,
    amount NUMERIC,
    status TEXT,
    kwh_used NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
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
    ORDER BY b.room_no;
$$;

-- Grant execute permission to anonymous users
GRANT EXECUTE ON FUNCTION get_public_bills() TO anon;
