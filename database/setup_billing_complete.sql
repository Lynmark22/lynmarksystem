-- ==================================================
-- COMPLETE BILLING SETUP (Run this to fix everything)
-- ==================================================

-- 1. Create the 'bills' table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.bills (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    room_no text NOT NULL,
    month date NOT NULL,
    previous_reading numeric DEFAULT 0,
    current_reading numeric DEFAULT 0,
    rate numeric DEFAULT 0,
    amount numeric DEFAULT 0,
    status text DEFAULT 'DUE', -- 'DUE' or 'PAID'
    user_id uuid, -- Optional linkage to auth.users if needed later
    created_at timestamptz DEFAULT now()
);

-- 2. Drop conflicting functions to clear the 'ambiguous function' error
DROP FUNCTION IF EXISTS get_bills(text);
DROP FUNCTION IF EXISTS get_bills(uuid);

-- 3. Create the correct 'get_bills' function
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

-- 4. Enable RLS (Security) - Optional but good practice
ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;

-- Allow public access (You can refine this later for stricter security)
CREATE POLICY "Public Access" ON public.bills
FOR ALL USING (true) WITH CHECK (true);
