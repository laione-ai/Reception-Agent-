// ============================================================
// Backfill inbound media — one-off, idempotent, rate-limited.
//
// Walks `messages` where `media_url LIKE '/api/whatsapp/media/%'`
// and `created_at > now() - interval '7 days'`, extracts each
// media ID, and persists it using the owning account's token.
//
// Auth: x-cron-secret header (AUTOMATION_CRON_SECRET), same
// pattern as /api/dental/cron and /api/flows/cron.
//
// Hit this endpoint once after deploy:
//   GET /api/whatsapp/media/backfill
//   Header: x-cron-secret: <AUTOMATION_CRON_SECRET>
//
// Anything older than 7 days is unrecoverable — Meta has already
// deleted it. Each day of delay costs another day's attachments.
//
// Idempotent: re-running re-attempts failed items and reports
// `already_stored` for items that are already persisted.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { persistInboundMedia } from '@/lib/whatsapp/persist-inbound-media'

export const maxDuration = 300 // 5 minutes — large backfills may be slow

/**
 * Delay between individual media downloads to avoid Meta rate limits.
 * 500ms keeps us well under Meta's undocumented per-second cap.
 */
const DELAY_MS = 500

/** Extract the media ID from a proxy URL like `/api/whatsapp/media/<id>`. */
function extractMediaId(proxyUrl: string): string | null {
  const prefix = '/api/whatsapp/media/'
  if (!proxyUrl.startsWith(prefix)) return null
  const id = proxyUrl.slice(prefix.length).split('/')[0]
  return id || null
}

export async function GET(request: Request) {
  // ── Auth ──────────────────────────────────────────────────
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)

  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const totals = { stored: 0, already_stored: 0, expired: 0, failed: 0, skipped: 0 }

  try {
    // ── 1. Load all WhatsApp configs (one per account) ──────
    const { data: configs, error: cfgErr } = await admin
      .from('whatsapp_config')
      .select('account_id, access_token')

    if (cfgErr || !configs || configs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No WhatsApp configs found — nothing to backfill.',
        totals,
      })
    }

    // ── 2. For each account, find media messages < 7 days old ─
    for (const config of configs) {
      let accessToken: string
      try {
        accessToken = decrypt(config.access_token)
      } catch (err) {
        console.error(
          `[backfill] cannot decrypt token for account ${config.account_id}:`,
          err instanceof Error ? err.message : err,
        )
        continue
      }

      // Fetch messages with proxy media URLs created in the last 7 days.
      // Paginate in chunks of 100 to avoid overloading memory on large
      // tenants. Supabase default limit is 1000, but 100 is safer here.
      let offset = 0
      const PAGE_SIZE = 100
      let hasMore = true

      while (hasMore) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const { data: messages, error: msgErr } = await admin
          .from('messages')
          .select('media_url, conversation_id, conversations!inner(account_id)')
          .eq('conversations.account_id', config.account_id)
          .like('media_url', '/api/whatsapp/media/%')
          .gte('created_at', sevenDaysAgo)
          .order('created_at', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)

        if (msgErr) {
          console.error(
            `[backfill] query error for account ${config.account_id}:`,
            msgErr.message,
          )
          break
        }

        if (!messages || messages.length === 0) {
          hasMore = false
          break
        }

        // ── 3. Persist each media file ──────────────────────
        for (const msg of messages) {
          const mediaId = extractMediaId(msg.media_url)
          if (!mediaId) continue

          const result = await persistInboundMedia(
            admin,
            config.account_id,
            mediaId,
            accessToken,
          )

          switch (result.status) {
            case 'stored':
              totals.stored++
              break
            case 'already_stored':
              totals.already_stored++
              break
            case 'skipped':
              totals.skipped++
              break
            case 'failed': {
              // Distinguish "expired on Meta" from other failures.
              const reason = result.reason?.toLowerCase() ?? ''
              if (
                reason.includes('does not exist') ||
                reason.includes('missing permissions') ||
                reason.includes('does not support this operation')
              ) {
                totals.expired++
              } else {
                totals.failed++
                console.error(
                  `[backfill] failed for ${mediaId} (account ${config.account_id}): ${result.reason}`,
                )
              }
              break
            }
          }

          // Rate-limit to avoid hammering Meta.
          if (result.status === 'stored') {
            await new Promise((r) => setTimeout(r, DELAY_MS))
          }
        }

        offset += messages.length
        if (messages.length < PAGE_SIZE) {
          hasMore = false
        }
      }
    }

    return NextResponse.json({
      ok: true,
      totals,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[backfill] unexpected error:', error)
    return NextResponse.json(
      {
        error: 'Internal error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
