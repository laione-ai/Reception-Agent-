import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  inboundMediaPath,
  persistInboundMedia,
} from '@/lib/whatsapp/persist-inbound-media'

// Known Meta error strings that indicate media is gone/unauthorized.
const MEDIA_GONE_PATTERNS = [
  'does not exist',
  'cannot be loaded due to missing permissions',
  'does not support this operation',
]

function isMediaGoneError(message: string): boolean {
  const lower = message.toLowerCase()
  return MEDIA_GONE_PATTERNS.some((p) => lower.includes(p))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // ── Storage-first: check private bucket ──────────────────────
    const admin = supabaseAdmin()
    const storagePath = inboundMediaPath(accountId, mediaId)

    const { data: fileData, error: downloadErr } = await admin.storage
      .from('inbound-media')
      .download(storagePath)

    if (!downloadErr && fileData) {
      // Served from our own storage — Meta expiry is irrelevant.
      const arrayBuffer = await fileData.arrayBuffer()
      return new Response(new Uint8Array(arrayBuffer), {
        status: 200,
        headers: {
          'Content-Type': fileData.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
        },
      })
    }

    // ── Fall back to Meta (pre-fix messages still in 7-day window) ─
    // Fetch and decrypt WhatsApp config
    // Service-role: decrypts access_token to fetch media from Meta. §6.2
    // revokes credential columns from `authenticated`. Tenancy preserved by
    // the explicit account_id filter.
    const { data: config, error: configError } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    let mediaInfo: { url: string; mimeType: string }
    try {
      mediaInfo = await getMediaUrl({ mediaId, accessToken })
    } catch (error) {
      // ── Classify the failure ──────────────────────────────────
      const errMsg = error instanceof Error ? error.message : String(error)
      if (isMediaGoneError(errMsg)) {
        return NextResponse.json(
          {
            error: 'media_unavailable',
            message:
              'This attachment is no longer available. ' +
              'WhatsApp only retains media files for 7 days after delivery.',
          },
          {
            status: 410,
            headers: { 'Cache-Control': 'private, max-age=86400' },
          },
        )
      }
      // Genuinely unexpected — keep 500.
      console.error('Error resolving media URL from Meta:', error)
      return NextResponse.json(
        { error: 'Failed to fetch media' },
        { status: 500 }
      )
    }

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    // ── Heal on read: persist so next request is storage-first ──
    // Fire-and-forget — don't delay the response.
    persistInboundMedia(admin, accountId, mediaId, accessToken).then(
      (r) => {
        if (r.status === 'failed') {
          console.error(`[media-heal] failed for ${mediaId}: ${r.reason}`)
        }
      },
    )

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    if (isMediaGoneError(errMsg)) {
      return NextResponse.json(
        {
          error: 'media_unavailable',
          message:
            'This attachment is no longer available. ' +
            'WhatsApp only retains media files for 7 days after delivery.',
        },
        {
          status: 410,
          headers: { 'Cache-Control': 'private, max-age=86400' },
        },
      )
    }
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
