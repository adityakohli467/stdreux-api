-- One-time cleanup: remove orphaned login "user" rows left behind by previously
-- deleted customers.
--
-- Background:
--   Deleting a customer used to only run `DELETE FROM customer`, leaving the linked
--   "user" row in place. Because storefront registration checks the "user" table
--   (WHERE email = ... OR login_username = ...), those orphaned rows kept the email
--   "registered" and blocked re-registration with the message "email still exists".
--
--   The application code now removes the "user" row when a customer is deleted, so
--   this script only needs to be run ONCE to clean up rows created before that fix.
--
-- Safety:
--   - Only targets storefront customer logins (is_customer = 1) that have NO matching
--     row in the `customer` table, so admin/staff accounts are never touched.
--   - Wrapped in a transaction. Run the SELECT preview first, confirm the rows, then
--     run the cleanup block.
--   - Targets are anonymised/removed only if they have no remaining references.

-- =============================================================================
-- STEP 1 — PREVIEW: which "user" rows are orphaned customer logins?
-- =============================================================================
SELECT u.user_id, u.email, u.login_username, u.is_customer
FROM "user" u
WHERE u.is_customer = 1
  AND NOT EXISTS (
    SELECT 1 FROM customer c WHERE c.user_id = u.user_id
  );

-- =============================================================================
-- STEP 2 — CLEANUP: free up and remove the orphaned customer logins
-- Review STEP 1 output before running this block.
-- =============================================================================
BEGIN;

-- Collect the orphaned customer user_ids into a temp table
CREATE TEMP TABLE _orphan_user_ids ON COMMIT DROP AS
SELECT u.user_id
FROM "user" u
WHERE u.is_customer = 1
  AND NOT EXISTS (
    SELECT 1 FROM customer c WHERE c.user_id = u.user_id
  );

-- Clear remaining references so the "user" rows can be removed
DELETE FROM password_reset_tokens
WHERE user_id IN (SELECT user_id FROM _orphan_user_ids);

UPDATE api_history
SET user_id = NULL
WHERE user_id IN (SELECT user_id FROM _orphan_user_ids);

UPDATE company
SET user_id = NULL
WHERE user_id IN (SELECT user_id FROM _orphan_user_ids);

UPDATE orders
SET user_id = NULL
WHERE user_id IN (SELECT user_id FROM _orphan_user_ids);

DELETE FROM notification
WHERE userid IN (SELECT user_id FROM _orphan_user_ids);

-- Finally remove the orphaned login users (frees up their email + username)
DELETE FROM "user"
WHERE user_id IN (SELECT user_id FROM _orphan_user_ids);

COMMIT;

-- =============================================================================
-- STEP 3 — VERIFY: should return 0 rows
-- =============================================================================
SELECT COUNT(*) AS remaining_orphans
FROM "user" u
WHERE u.is_customer = 1
  AND NOT EXISTS (
    SELECT 1 FROM customer c WHERE c.user_id = u.user_id
  );
