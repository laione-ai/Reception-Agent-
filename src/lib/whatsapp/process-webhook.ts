import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import { resolveConnectionForChange } from '@/lib/whatsapp/resolve-connection'
import { isDentalButtonReply, handleDentalButtonReply } from '@/lib/dental/webhook-handler'
import type { WhatsAppConfig } from '@/types'

// ---------------------------------------------------------------------------
// Inbound webhook processing, extracted verbatim from
// `src/app/api/whatsapp/webhook/route.ts` (claude-01 §4.4 Commit A — pure
// move, no behaviour change). `claude-02` adds a second route (the provider /
// embedded webhook) that calls this same processor, so it can no longer live
// inside one route file. §4.4.1 (Commit B) reshapes the contract on top of
// this; this commit only relocates the code.
// ---------------------------------------------------------------------------

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

export interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

export interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        // Meta attaches this on `status: 'failed'`. Previously absent
        // from this type, so the reason a message failed was silently
        // discarded — the inbox showed a red ✗ with no explanation
        // anywhere in the logs or the DB. `error_data.details` is the
        // most specific string Meta gives you (e.g. the actual reason
        // behind a 131042 billing block).
        errors?: Array<{
          code: number
          title?: string
          message?: string
          error_data?: { details?: string }
        }>
      }>
    }
    field: string
  }>
}

/** One element of `entry.changes` — the unit of work (§4.4.1). */
export type WhatsAppChange = WhatsAppWebhookEntry['changes'][number]

export async function processWebhook(
  body: { entry?: WhatsAppWebhookEntry[] },
  // The connection whose App Secret verified this delivery. On the manual
  // route the signature authenticates EXACTLY ONE workspace (§4.1.2), so
  // only changes that resolve back to this same connection may be processed.
  expectedConfig: WhatsAppConfig,
) {
  if (!body.entry) return

  // The unit of work is a *change*, not an entry: `phone_number_id` lives on
  // change.value.metadata, and template events resolve by entry.id. Resolve
  // each change to its own connection, then dispatch. A change that resolves
  // to no connection (unknown / ambiguous) is skipped and logged, never
  // aborting its siblings (§4.4.1). claude-02's provider route reuses
  // `resolveConnectionForChange` but does NOT pass an expectedConfig — one
  // provider signature legitimately covers every embedded workspace, so it
  // gates on `connection_method === 'embedded'` instead (claude-02 §4.0).
  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const resolution = await resolveConnectionForChange(
        entry,
        change,
        supabaseAdmin(),
      )
      if (!resolution.ok) continue

      // §4.1.2 — THE tenancy boundary. Every manual client owns their Meta
      // app and therefore knows their own App Secret, so a client can forge
      // any payload and sign it validly. If we processed each change on
      // whatever connection it resolves to, client A could craft a change
      // carrying B's phone_number_id, sign it with A's own (valid) secret,
      // and write into B's inbox. The signature is genuine — it just does
      // not authenticate B. So: a change resolving to any connection other
      // than the one that signed this delivery is skipped and logged with
      // both accounts. If this check is ever removed, any manual client can
      // write into any other workspace.
      if (resolution.config.id !== expectedConfig.id) {
        console.error(
          '[webhook] SECURITY: a validly-signed change resolved to a ' +
            'different connection than the one that signed this delivery — ' +
            'skipping (possible cross-tenant forgery or a Meta bug). ' +
            `verified account=${expectedConfig.account_id} ` +
            `config=${expectedConfig.id}; change account=` +
            `${resolution.config.account_id} config=${resolution.config.id}`,
        )
        continue
      }

      await processWebhookChange(change, resolution.config)
    }
  }
}

/**
 * Process a single, already-resolved change against its connection. Every
 * write is scoped to `config.account_id`, which fixes the cross-tenant
 * status write (`claude-00` invariant 1): `message_id` is not unique across
 * numbers (migration 009), so a status mirror keyed on it alone would touch
 * another tenant's rows.
 */
export async function processWebhookChange(
  change: WhatsAppChange,
  config: WhatsAppConfig,
): Promise<void> {
  // Template-lifecycle events (status / quality / components updates from
  // Meta) come in on a different change.field and have a different value
  // shape — route them through the dedicated handler. Skip the messaging
  // branches below so we don't read message-shaped fields off a template
  // event.
  if (isTemplateWebhookField(change.field)) {
    await handleTemplateWebhookChange(
      { field: change.field, value: change.value as unknown },
      supabaseAdmin(),
    )
    return
  }

  const value = change.value

  // Handle status updates — scoped to the resolved account.
  if (value.statuses) {
    for (const status of value.statuses) {
      await handleStatusUpdate(status, config.account_id)
    }
  }

  // Handle incoming messages
  if (!value.messages || !value.contacts) return

  const decryptedAccessToken = decrypt(config.access_token)

  for (let i = 0; i < value.messages.length; i++) {
    const message = value.messages[i]
    const contact = value.contacts[i] || value.contacts[0]

    await processMessage(
      message,
      contact,
      // Tenancy — drives every contact / conversation lookup
      // and the engines' active-row dispatch.
      config.account_id,
      // Audit / sender-of-record — used as the user_id on row
      // inserts that need it for NOT NULL FK compliance. Always
      // the admin who saved the WhatsApp config.
      config.user_id,
      decryptedAccessToken
    )
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(
  status: {
    id: string
    status: string
    timestamp: string
    recipient_id: string
    errors?: Array<{
      code: number
      title?: string
      message?: string
      error_data?: { details?: string }
    }>
  },
  // The account this status was verified/resolved for. `messages` has no
  // account_id of its own, so this is the tenant scope for the mirror
  // below — without it, `message_id` (non-unique, migration 009) would
  // let one client's status webhook rewrite another client's message.
  accountId: string,
) {
  // 0) Surface WHY a message failed. Meta only attaches `errors` on
  //    `status: 'failed'`; without this the inbox renders a red ✗ and
  //    the reason is lost forever. Logged loudly and in full — the
  //    common codes here are account-level (131042 billing/eligibility,
  //    131049 undeliverable, 131047 outside the 24h window) and none of
  //    them are diagnosable from the status value alone.
  if (status.status === 'failed' && status.errors?.length) {
    for (const e of status.errors) {
      console.error(
        `[whatsapp] message ${status.id} to ${status.recipient_id} FAILED — ` +
          `code=${e.code} title="${e.title ?? ''}" ` +
          `details="${e.error_data?.details ?? e.message ?? ''}"`,
      )
    }
  } else if (status.status === 'failed') {
    console.error(
      `[whatsapp] message ${status.id} to ${status.recipient_id} FAILED — ` +
        `Meta sent no error detail.`,
    )
  }

  // 1) Mirror onto messages — SCOPED to this account (§4.4). `messages`
  //    has no account_id, so scope through the conversation: look up this
  //    account's message rows carrying this (non-unique) message_id, then
  //    update exactly those by primary key. `conversations.account_id` is
  //    immutable, so there is no race between the lookup and the update.
  //    Still 0..N rows — now bounded to one tenant. A single joined UPDATE
  //    is ideal but the JS client doesn't express it cleanly (§4.4.2).
  const { data: ownRows, error: lookupErr } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', status.id)
    .eq('conversations.account_id', accountId)

  if (lookupErr) {
    console.error('Error looking up messages for status update:', lookupErr)
  } else if (ownRows && ownRows.length > 0) {
    const ids = ownRows.map((r: { id: string }) => r.id)
    const { error: msgErr } = await supabaseAdmin()
      .from('messages')
      .update({ status: status.status })
      .in('id', ids)

    if (msgErr) {
      console.error('Error updating message status:', msgErr)
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends). Runs
  //    last so a slow subscriber can't delay the mirrors above. The owning
  //    account is the one this status was resolved for (passed in), and
  //    step 1 already fetched this account's matching rows — reuse them
  //    rather than re-querying cross-tenant.
  if (ownRows && ownRows.length > 0) {
    await dispatchWebhookEvent(
      supabaseAdmin(),
      accountId,
      'message.status_updated',
      {
        whatsapp_message_id: status.id,
        conversation_id: (ownRows[0] as { conversation_id: string }).conversation_id,
        status: status.status,
      }
    )
  }
}

/**
 * Record that this account just received inbound traffic (§3.1).
 *
 * Diagnostic only, and deliberately unable to break the inbound path: every
 * failure mode — query error, thrown client, missing column on a deploy that
 * predates migration 037 — is logged and swallowed.
 *
 * One extra UPDATE per inbound message is fine at this scale; if volume ever
 * bites, throttle to once per minute per account rather than removing the
 * signal. There is deliberately no `last_outbound_at` counterpart: three send
 * paths bypass `send-message.ts`, so the column would read "never" while
 * broadcasts were sending fine, and a diagnostic that lies is worse than none.
 */
async function stampLastInboundAt(accountId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({ last_inbound_at: new Date().toISOString() })
      .eq('account_id', accountId)

    if (error) {
      console.warn('[webhook] last_inbound_at stamp failed (non-fatal):', error.message ?? error)
    }
  } catch (err) {
    console.warn('[webhook] last_inbound_at stamp threw (non-fatal):', err)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Inbound health signal (§3.1). Stamped only after an inbound message is
  // actually persisted, so "last inbound 6 days ago" on a workspace that used
  // to receive hourly is the visible symptom of §1's silent-401 failure —
  // without opening the database.
  //
  // BEST-EFFORT BY CONTRACT: this is a diagnostic and must never become a new
  // way for messaging to fail, so a failure is logged and swallowed, never
  // propagated. Not awaited-for-correctness — the message is already saved.
  await stampLastInboundAt(accountId)

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // ============================================================
  // Dental appointment system — intercept dental_ button replies
  // BEFORE automations. If the dental system handles it, mark as
  // consumed so keyword_match / interactive_reply automations
  // don't double-process. Fire-and-forget: dental handler has its
  // own error handling and never throws.
  // ============================================================
  let dentalConsumed = false
  if (interactiveReplyId && isDentalButtonReply(interactiveReplyId) && !flowConsumed) {
    try {
      dentalConsumed = await handleDentalButtonReply(
        supabaseAdmin(),
        accountId,
        message.from, // patient's phone number
        interactiveReplyId,
      )
    } catch (err) {
      console.error('[dental] webhook handler failed:', err)
    }
  }

  const inboundText = contentText ?? message.text?.body ?? ''

  // ============================================================
  // Dental AI receptionist — free-text intent handling.
  //
  // Only fires when:
  //   1. The account has dental_clinic_config.agent_enabled = true
  //   2. The message is free text (not an interactive button reply)
  //   3. No Flow consumed it
  //   4. No dental button handler consumed it
  //
  // Cheap early-exit: one indexed maybeSingle() on dental_clinic_config.
  // Non-dental tenants pay ~1ms for this check.
  //
  // When consumed, suppresses BOTH automations AND generic AI
  // auto-reply — the dental agent is the sole responder.
  // ============================================================
  let dentalAgentConsumed = false
  let isDentalAccount = false
  if (!flowConsumed && !dentalConsumed && !interactiveReplyId && inboundText.trim()) {
    try {
      const { dispatchInboundToDentalAgent } = await import(
        '@/lib/dental/agent/dispatch'
      )
      const dentalResult = await dispatchInboundToDentalAgent({
        accountId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        phone: message.from,
        text: inboundText,
        configOwnerUserId,
        waMessageId: message.id,
      })
      dentalAgentConsumed = dentalResult.consumed
      isDentalAccount = dentalResult.isDentalAccount
    } catch (err) {
      console.error('[dental agent] dispatch failed:', err)
    }
  }

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed && !dentalConsumed && !dentalAgentConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  //
  // IMPORTANT: When isDentalAccount is true the generic AI is suppressed
  // even if the dental agent failed to consume the message — a dental
  // account must never fall through to the fully-generic assistant that
  // has no clinic context. The patient gets silence (or a human picks up)
  // rather than an un-scoped LLM answering on the clinic's behalf.
  if (!flowConsumed && !dentalAgentConsumed && !isDentalAccount && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
