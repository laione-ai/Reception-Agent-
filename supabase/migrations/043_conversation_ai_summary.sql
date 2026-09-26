-- ============================================================
-- 043: Add rolling AI summary columns to conversations
--
-- Long-term memory for the dental AI receptionist. The agent
-- sees the most recent messages verbatim; everything older is
-- folded incrementally into a short rolling summary stored
-- here, so returning patients keep their context without
-- sending the whole thread to the model on every turn.
--
-- ai_summary_through marks how far the summary has consumed
-- the thread, so each refresh only summarises new messages.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS ai_summary_through timestamptz;

COMMENT ON COLUMN conversations.ai_summary IS
  'Rolling AI-generated notes summarising messages older than the '
  'recent window the agent sees verbatim. Null until enough history '
  'has accumulated to summarise.';

COMMENT ON COLUMN conversations.ai_summary_through IS
  'created_at of the newest message folded into ai_summary. Messages '
  'after this are not yet summarised. Null when there is no summary.';
