-- ============================================================
-- 042: Add name_confirmed column to dental_patients
--
-- Tracks whether a patient's full_name has been explicitly
-- confirmed by the patient themselves (via the AI agent) vs.
-- auto-pulled from their WhatsApp display name (unreliable).
--
-- Existing patients get name_confirmed = false so the agent
-- will confirm their name on the next interaction.
-- ============================================================

ALTER TABLE dental_patients
  ADD COLUMN IF NOT EXISTS name_confirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN dental_patients.name_confirmed IS
  'True when the patient has explicitly confirmed their full name '
  '(via the AI receptionist or staff). False when the name was '
  'auto-pulled from their WhatsApp profile and never verified.';
