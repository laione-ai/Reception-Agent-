import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

// ============================================================
// Persist inbound WhatsApp media to the private `inbound-media`
// bucket so it survives Meta's 7-day expiry.
//
// Deterministic path: `account-<accountId>/<mediaId>`
//   – No lookup table needed.
//   – Tenant-isolated by construction.
//   – Idempotent: webhook retries upload to the same path.
//
// NEVER THROWS. Every failure returns a `failed` or `skipped`
// status so the caller can proceed with the proxy URL.
// ============================================================

const BUCKET = 'inbound-media'

/** 16 MB — matches the bucket's file_size_limit. */
const MAX_PERSIST_BYTES = 16 * 1024 * 1024

export type PersistResult =
  | { status: 'stored'; mimeType: string }
  | { status: 'already_stored'; mimeType: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

/**
 * Build the deterministic storage path for an inbound media object.
 * Pure + exported for testability and for the route to look up objects.
 */
export function inboundMediaPath(accountId: string, mediaId: string): string {
  return `account-${accountId}/${mediaId}`
}

/**
 * Download an inbound media file from Meta and upload it to the
 * private `inbound-media` bucket. Idempotent: re-runs for the
 * same (accountId, mediaId) are a no-op.
 *
 * @param adminClient  Service-role Supabase client (bypasses RLS).
 * @param accountId    The owning account's UUID.
 * @param mediaId      Meta's media ID from the webhook payload.
 * @param accessToken  Decrypted WhatsApp access token.
 */
export async function persistInboundMedia(
  adminClient: SupabaseClient,
  accountId: string,
  mediaId: string,
  accessToken: string,
): Promise<PersistResult> {
  const path = inboundMediaPath(accountId, mediaId)

  try {
    // 1. Check if already stored (idempotency for webhook retries).
    //    A HEAD-like check is cheap — avoids re-downloading from Meta.
    const { data: existing } = await adminClient.storage
      .from(BUCKET)
      .createSignedUrl(path, 1) // 1-second URL; we just need to know it exists
    if (existing?.signedUrl) {
      return { status: 'already_stored', mimeType: 'unknown' }
    }

    // 2. Resolve Meta's short-lived download URL + file_size.
    let metaUrl: string
    let mimeType: string
    let fileSize: number | undefined
    try {
      const info = await getMediaUrl({ mediaId, accessToken })
      metaUrl = info.url
      mimeType = info.mimeType
      fileSize = info.fileSize
    } catch (err) {
      return {
        status: 'failed',
        reason: `getMediaUrl: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 3. Size gate BEFORE downloading — avoid buffering 100 MB.
    if (fileSize && fileSize > MAX_PERSIST_BYTES) {
      return {
        status: 'skipped',
        reason: `file_size ${fileSize} exceeds ${MAX_PERSIST_BYTES} cap`,
      }
    }

    // 4. Download the binary.
    let buffer: Buffer
    let contentType: string
    try {
      const dl = await downloadMedia({ downloadUrl: metaUrl, accessToken })
      buffer = dl.buffer
      contentType = dl.contentType
    } catch (err) {
      return {
        status: 'failed',
        reason: `downloadMedia: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // Post-download size check (file_size may have been absent from Meta).
    if (buffer.length > MAX_PERSIST_BYTES) {
      return {
        status: 'skipped',
        reason: `downloaded ${buffer.length} bytes exceeds ${MAX_PERSIST_BYTES} cap`,
      }
    }

    // 5. Upload to the private bucket. Use `upsert: true` for
    //    idempotency in case the exists-check raced with another
    //    concurrent upload (e.g. webhook retry + heal-on-read).
    const resolvedMime = contentType || mimeType || 'application/octet-stream'
    const { error: uploadErr } = await adminClient.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: resolvedMime,
        upsert: true,
      })

    if (uploadErr) {
      return {
        status: 'failed',
        reason: `upload: ${uploadErr.message}`,
      }
    }

    return { status: 'stored', mimeType: resolvedMime }
  } catch (err) {
    // Catch-all safety net — this function must never throw.
    return {
      status: 'failed',
      reason: `unexpected: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
