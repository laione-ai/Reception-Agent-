-- ============================================================
-- 043_inbound_media.sql
--
-- Private storage bucket for inbound WhatsApp media (images,
-- videos, documents, audio/voice notes, stickers received from
-- patients).
--
-- WHY: Meta deletes webhook-delivered media after 7 days. Today
-- every attachment is stored as a lazy proxy URL that re-fetches
-- from Meta on every view — after 7 days, gone forever. This
-- bucket lets the webhook persist each file at receipt.
--
-- PRIVACY: The bucket is PRIVATE (public = FALSE). There are NO
-- policies for `anon` or `authenticated` — all reads and writes
-- go through the service-role client inside the webhook handler
-- and the authenticated media proxy route, which resolve the
-- caller's account_id from their session and scope every object
-- path to `account-<account_id>/<media_id>`.
--
-- Path convention:
--   inbound-media/account-<account_id>/<media_id>
--
-- Size limit: 16 MB — matches chat-media / flow-media. Meta
-- allows up to 100 MB inbound, but larger files are skipped
-- (they fall back to the live proxy and expire after 7 days).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'inbound-media',
  'inbound-media',
  FALSE,
  16777216  -- 16 MB
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- ============================================================
-- 2. Explicitly deny authenticated direct access
--
-- The bucket has NO policies, so RLS denies everything by
-- default. This section is a safety net: if someone adds a
-- permissive policy later, these explicit denies document the
-- intent. (Postgres evaluates policies as OR — a deny policy
-- can't override a permissive one, but the absence of ANY
-- permissive policy achieves the same effect. These comments
-- serve as documentation.)
--
-- All access goes through the service-role client, which
-- bypasses RLS entirely. The proxy route authenticates the
-- user, resolves their account_id, and constructs the object
-- path — tenant isolation is by construction, not by policy.
-- ============================================================

-- No policies are created. This is intentional.
-- DO NOT add SELECT/INSERT/UPDATE/DELETE policies for 'anon'
-- or 'authenticated' roles on this bucket.
