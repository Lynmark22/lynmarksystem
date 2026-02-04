-- ==================================================
-- SETUP: BULK UPDATE FUNCTIONS
-- ==================================================

-- 1. Bulk Update Period (Start & End)
-- Updates period_start, period_end, and sets 'month' to period_end for sorting
CREATE OR REPLACE FUNCTION bulk_update_period(
    p_user_id uuid,
    p_period_start date,
    p_period_end date
)
RETURNS json
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE bills
    SET 
        period_start = p_period_start,
        period_end = p_period_end,
        month = p_period_end -- Sync legacy month field
    WHERE user_id = p_user_id;

    RETURN json_build_object('success', true, 'updated_count', (SELECT COUNT(*) FROM bills WHERE user_id = p_user_id));
END;
$$;

-- 2. Bulk Update Rate
-- Updates rate AND recalculates amount for consistency
CREATE OR REPLACE FUNCTION bulk_update_rate(
    p_user_id uuid,
    p_rate numeric
)
RETURNS json
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE bills
    SET 
        rate = p_rate,
        amount = (current_reading - previous_reading) * p_rate
    WHERE user_id = p_user_id;

    RETURN json_build_object('success', true, 'updated_count', (SELECT COUNT(*) FROM bills WHERE user_id = p_user_id));
END;
$$;
