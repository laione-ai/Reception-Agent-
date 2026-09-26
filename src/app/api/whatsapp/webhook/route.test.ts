import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'

// ---------------------------------------------------------------------------
// Tests for the inbound WhatsApp webhook route (P1-10).
//
// Began at §8.0b as characterization tests pinning the route's behaviour before
// the §8.4 extraction and the §8.5/§8.6 rewrite, which is why the pure move at
// 8.4 could be verified against them unmodified. They have since followed the
// deliberate behaviour changes into the §9 end state, each in the same commit
// as the change:
//   §4.1/§4.1.1 — an unknown or ambiguous sender is now rejected 401 at the
//     gate (was 200 + a silent internal drop).
//   §4.4       — the status mirror is scoped to the resolved account's own row
//     ids (was a bare, cross-tenant message_id filter).
//   §4.1.2     — the cross-tenant forgery guard. If those tests are ever
//     deleted, any manual client can write into any other workspace.
//
// Boundaries mocked at IO only:
//   - @supabase/supabase-js  → in-memory admin client (records inserts/updates)
//   - next/server `after`    → captured + flushed manually, so the deferred
//                              processing runs deterministically in-test
//   - Meta API / engines / webhook fan-out → no-op spies
// Kept REAL (they run off the vitest env vars in vitest.config.ts):
//   - webhook-signature (HMAC over the raw body) — so raw-body sensitivity is
//     a genuine property under test, not a mock artifact
//   - encryption (AES-256-GCM) — real ciphertext round-trips the route
// ---------------------------------------------------------------------------

interface WebhookState {
  configs: Array<Record<string, unknown>> | null
  configError: unknown
  conversation: Record<string, unknown> | null
  existingContact: Record<string, unknown> | null
  broadcastRecipient: Record<string, unknown> | null
  // Account-scoped `messages` rows returned by handleStatusUpdate's scoped
  // lookup (§4.4): the rows in THIS account carrying the status's message_id.
  ownMessageRows: Array<Record<string, unknown>>
  priorCustomerMsgCount: number
  // Forces the best-effort last_inbound_at stamp to fail (§3.1).
  configUpdateError: unknown
}

interface Recorded {
  inserts: Record<string, Array<Record<string, unknown>>>
  updates: Record<string, Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }>>
  deletes: Record<string, Array<{ filters: Record<string, unknown> }>>
}

const h = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown> = []
  const state = {} as WebhookState
  const calls = { inserts: {}, updates: {}, deletes: {} } as Recorded
  const reset = () => {
    state.configs = []
    state.configError = null
    state.conversation = null
    state.existingContact = null
    state.broadcastRecipient = null
    state.ownMessageRows = []
    state.priorCustomerMsgCount = 0
    state.configUpdateError = null
    calls.inserts = {}
    calls.updates = {}
    calls.deletes = {}
    afterCallbacks.length = 0
  }
  return { afterCallbacks, state, calls, reset }
})

function record<T>(bucket: Record<string, T[]>, table: string, value: T) {
  ;(bucket[table] ??= []).push(value)
}

// A minimal chainable stand-in for the Supabase service-role client. Every
// query builder method returns the same builder; the terminal (`then`,
// `single`, `maybeSingle`) resolves against per-test `h.state` and records
// write payloads into `h.calls`.
function makeAdminClient() {
  function from(table: string) {
    const ctx = {
      op: 'select' as 'select' | 'insert' | 'update' | 'delete',
      filters: {} as Record<string, unknown>,
      selectArg: undefined as unknown,
      count: false,
      payload: null as Record<string, unknown> | null,
    }
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = (arg?: unknown, opts?: { head?: boolean }) => {
      ctx.selectArg = arg
      if (opts?.head) ctx.count = true
      return b
    }
    b.eq = (key: string, value: unknown) => {
      ctx.filters[key] = value
      return b
    }
    b.neq = chain
    b.in = (col: string, values: unknown) => {
      ctx.filters[`${col}__in`] = values
      return b
    }
    b.order = chain
    b.limit = chain
    b.insert = (payload: Record<string, unknown>) => {
      ctx.op = 'insert'
      ctx.payload = payload
      return b
    }
    b.update = (payload: Record<string, unknown>) => {
      ctx.op = 'update'
      ctx.payload = payload
      return b
    }
    b.delete = () => {
      ctx.op = 'delete'
      return b
    }

    const resolve = (): Record<string, unknown> => {
      if (ctx.op === 'insert') {
        record(h.calls.inserts, table, ctx.payload ?? {})
        return { data: null, error: null }
      }
      if (ctx.op === 'update') {
        record(h.calls.updates, table, { payload: ctx.payload ?? {}, filters: ctx.filters })
        return {
          data: null,
          error: table === 'whatsapp_config' ? h.state.configUpdateError : null,
        }
      }
      if (ctx.op === 'delete') {
        record(h.calls.deletes, table, { filters: ctx.filters })
        return { data: null, error: null }
      }
      switch (table) {
        case 'whatsapp_config': {
          // The GET verify-token loop selects with no phone/waba filter and
          // wants every row; resolveConnectionForChange filters by exactly
          // one of phone_number_id / waba_id. Emulate that `.eq()` filter so
          // multi-config deliveries resolve to the right row.
          if (h.state.configs == null) {
            return { data: h.state.configs, error: h.state.configError }
          }
          let rows = h.state.configs
          if ('phone_number_id' in ctx.filters) {
            rows = rows.filter((r) => r.phone_number_id === ctx.filters.phone_number_id)
          } else if ('waba_id' in ctx.filters) {
            rows = rows.filter((r) => r.waba_id === ctx.filters.waba_id)
          }
          return { data: rows, error: h.state.configError }
        }
        case 'conversations':
          return { data: h.state.conversation ? [h.state.conversation] : [], error: null }
        case 'broadcast_recipients':
          // flagBroadcastReplyIfAny selects with the `broadcasts` join and
          // awaits an array; the status mirror selects `id, status` and
          // uses maybeSingle (a single row).
          if (typeof ctx.selectArg === 'string' && ctx.selectArg.includes('broadcasts')) {
            return { data: [], error: null }
          }
          return { data: h.state.broadcastRecipient, error: null }
        case 'messages':
          if (ctx.count) return { count: h.state.priorCustomerMsgCount, error: null }
          // The account-scoped lookup in handleStatusUpdate.
          return { data: h.state.ownMessageRows, error: null }
        default:
          return { data: null, error: null }
      }
    }

    b.single = async () => resolve()
    b.maybeSingle = async () => resolve()
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve().then(resolve).then(onFulfilled, onRejected)
    return b
  }
  return { from }
}

const adminClient = makeAdminClient()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => adminClient,
}))

// `after()` throws outside a Next request scope; capture the callback so the
// test can run the deferred work on demand and assert what it wrote.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (cb: () => unknown) => {
      h.afterCallbacks.push(cb)
    },
  }
})

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => h.state.existingContact),
  isUniqueViolation: vi.fn(() => false),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({})),
  downloadMedia: vi.fn(async () => ({})),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}))

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => {}),
}))

vi.mock('@/lib/ai/transcribe', () => ({
  transcribeVoiceNote: vi.fn(async () => ({ status: 'skipped', reason: 'test default' })),
}))

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}))

// Mirrors the real predicate (the three `message_template_*` fields) so
// template-lifecycle routing is exercised for real; the handler itself is a
// spy we can assert against.
const templateWebhook = vi.hoisted(() => ({
  isTemplateWebhookField: vi.fn((field: string) => field.startsWith('message_template_')),
  handleTemplateWebhookChange: vi.fn(
    async (_change: { field: string; value: unknown }, _db: unknown) => {},
  ),
}))
vi.mock('@/lib/whatsapp/template-webhook', () => templateWebhook)

import { GET, POST } from './route'
import { transcribeVoiceNote } from '@/lib/ai/transcribe'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

const SECRET = process.env.META_APP_SECRET as string

function sign(body: string, secret: string = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function flushAfter() {
  const cbs = h.afterCallbacks.splice(0)
  for (const cb of cbs) await cb()
}

function getRequest(params: Record<string, string>) {
  const url = new URL('http://localhost/api/whatsapp/webhook')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return GET(new Request(url))
}

function postRequest(rawBody: string, signature: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-hub-signature-256'] = signature
  return POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers,
      body: rawBody,
    }),
  )
}

function inboundMessageBody(phoneNumberId = 'PNID-1') {
  return {
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550000000',
                phone_number_id: phoneNumberId,
              },
              contacts: [{ profile: { name: 'Alice' }, wa_id: '15551112222' }],
              messages: [
                {
                  id: 'wamid.ABC',
                  from: '15551112222',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

function statusBody(
  opts: { id?: string; status?: string; timestamp?: string; phoneNumberId?: string } = {},
) {
  const { id = 'wamid.S', status = 'delivered', timestamp = '1700000000', phoneNumberId = 'PNID-1' } =
    opts
  return {
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'x', phone_number_id: phoneNumberId },
              statuses: [{ id, status, timestamp, recipient_id: '15551112222' }],
            },
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  h.reset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/whatsapp/webhook — verification handshake', () => {
  it('returns the challenge as text/plain when a verify token matches', async () => {
    h.state.configs = [{ id: 'c1', verify_token: encrypt('MY_TOKEN') }]
    const res = await getRequest({
      'hub.mode': 'subscribe',
      'hub.challenge': 'CHALLENGE-123',
      'hub.verify_token': 'MY_TOKEN',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('CHALLENGE-123')
  })

  it('returns 403 when no config verify token matches', async () => {
    h.state.configs = [{ id: 'c1', verify_token: encrypt('MY_TOKEN') }]
    const res = await getRequest({
      'hub.mode': 'subscribe',
      'hub.challenge': 'CHALLENGE-123',
      'hub.verify_token': 'WRONG_TOKEN',
    })
    expect(res.status).toBe(403)
  })

  it('skips an undecryptable token row rather than failing, and matches a later good row', async () => {
    h.state.configs = [
      { id: 'bad', verify_token: 'not-a-valid-ciphertext' },
      { id: 'good', verify_token: encrypt('MY_TOKEN') },
    ]
    const res = await getRequest({
      'hub.mode': 'subscribe',
      'hub.challenge': 'CHALLENGE-123',
      'hub.verify_token': 'MY_TOKEN',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CHALLENGE-123')
  })

  it('returns 400 when required verification params are missing', async () => {
    const res = await getRequest({ 'hub.mode': 'subscribe' })
    expect(res.status).toBe(400)
  })

  it('returns 403 when the config lookup errors', async () => {
    h.state.configs = null
    h.state.configError = { message: 'db down' }
    const res = await getRequest({
      'hub.mode': 'subscribe',
      'hub.challenge': 'CHALLENGE-123',
      'hub.verify_token': 'MY_TOKEN',
    })
    expect(res.status).toBe(403)
  })
})

// A resolvable manual connection with NO app_secret (grandfathered row) —
// verified via the META_APP_SECRET fallback, which is what `sign()` uses by
// default. `access_token` is a placeholder because these tests reject before
// any message is processed (nothing decrypts it).
const INBOUND_CONFIG = {
  id: 'cfg1',
  account_id: 'acct-1',
  user_id: 'user-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc',
}

describe('POST /api/whatsapp/webhook — signature gate', () => {
  it('accepts a body signed with the META_APP_SECRET fallback (no app_secret) and persists the inbound message', async () => {
    h.state.configs = [
      {
        id: 'cfg1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        access_token: encrypt('ACCESS-TOKEN'),
        // no app_secret → grandfathered row verifies via META_APP_SECRET
      },
    ]
    h.state.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      unread_count: 0,
    }
    h.state.existingContact = { id: 'contact-1', name: 'Alice', account_id: 'acct-1' }

    const raw = JSON.stringify(inboundMessageBody())
    const res = await postRequest(raw, sign(raw))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })

    await flushAfter()

    const messageInserts = h.calls.inserts.messages ?? []
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.ABC',
      status: 'delivered',
    })

    // §3.1 — inbound health signal, stamped for the resolved account only.
    const stamps = h.calls.updates.whatsapp_config ?? []
    expect(stamps).toHaveLength(1)
    expect(stamps[0].payload.last_inbound_at).toBeTruthy()
    expect(stamps[0].filters).toEqual({ account_id: 'acct-1' })
  })

  it('still persists the message when the last_inbound_at stamp fails (best-effort, §3.1)', async () => {
    h.state.configs = [
      {
        id: 'cfg1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        access_token: encrypt('ACCESS-TOKEN'),
      },
    ]
    h.state.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      unread_count: 0,
    }
    h.state.existingContact = { id: 'contact-1', name: 'Alice', account_id: 'acct-1' }
    // The diagnostic must never become a new way for messaging to fail.
    h.state.configUpdateError = { message: 'column last_inbound_at does not exist' }

    const raw = JSON.stringify(inboundMessageBody())
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(200)

    // Does not throw out of the after() callback, and the message still lands.
    await flushAfter()
    expect(h.calls.inserts.messages ?? []).toHaveLength(1)
    // The conversation summary update still ran after the failed stamp.
    expect(h.calls.updates.conversations ?? []).toHaveLength(1)
  })

  it("verifies with the connection's own app_secret when set (per-client secret)", async () => {
    h.state.configs = [
      {
        id: 'cfg1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        access_token: encrypt('ACCESS-TOKEN'),
        app_secret: encrypt('client-app-secret'),
      },
    ]
    h.state.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      unread_count: 0,
    }
    h.state.existingContact = { id: 'contact-1', name: 'Alice', account_id: 'acct-1' }

    const raw = JSON.stringify(inboundMessageBody())
    // Signed with the client's own App Secret, NOT META_APP_SECRET.
    const res = await postRequest(raw, sign(raw, 'client-app-secret'))

    expect(res.status).toBe(200)
    await flushAfter()
    expect(h.calls.inserts.messages ?? []).toHaveLength(1)
  })

  it("rejects a body signed with the wrong secret for a connection that has its own app_secret (401)", async () => {
    h.state.configs = [
      {
        id: 'cfg1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        access_token: 'enc',
        app_secret: encrypt('client-app-secret'),
      },
    ]
    const raw = JSON.stringify(inboundMessageBody())
    // Signed with META_APP_SECRET, but this connection verifies with its own
    // app_secret — so the env fallback must NOT rescue it.
    const res = await postRequest(raw, sign(raw))

    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
    await flushAfter()
    expect(h.calls.inserts.messages).toBeUndefined()
  })

  it('rejects an invalid signature (401), schedules no deferred work, and writes nothing', async () => {
    h.state.configs = [INBOUND_CONFIG]
    const raw = JSON.stringify(inboundMessageBody())
    const res = await postRequest(raw, sign(raw, 'the-wrong-secret'))

    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)

    await flushAfter()
    expect(h.calls.inserts.messages).toBeUndefined()
  })

  it('rejects when the signed bytes differ from the received bytes (raw-body sensitivity)', async () => {
    h.state.configs = [INBOUND_CONFIG]
    const payload = inboundMessageBody()
    const signedBytes = JSON.stringify(payload)
    const header = sign(signedBytes)
    // Same JSON value, different bytes (pretty-printed) — a re-serialized body
    // must fail verification.
    const receivedBytes = JSON.stringify(payload, null, 2)
    const res = await postRequest(receivedBytes, header)
    expect(res.status).toBe(401)
  })

  it('rejects a missing signature header (401)', async () => {
    h.state.configs = [INBOUND_CONFIG]
    const raw = JSON.stringify(inboundMessageBody())
    const res = await postRequest(raw, null)
    expect(res.status).toBe(401)
  })
})

describe('POST /api/whatsapp/webhook — tenant resolution (§4.1.1)', () => {
  it('rejects (401) and writes nothing when no connection matches the phone_number_id', async () => {
    h.state.configs = []
    const raw = JSON.stringify(inboundMessageBody('UNKNOWN-PNID'))
    const res = await postRequest(raw, sign(raw))

    // 8.6 change: resolution now happens BEFORE processing, so an unknown
    // sender is rejected at the gate (was a 200 + internal drop pre-8.6).
    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
    await flushAfter()
    expect(h.calls.inserts.messages).toBeUndefined()
  })

  it('rejects (401) when two connections share a phone_number_id (ambiguous)', async () => {
    h.state.configs = [
      { id: 'a', account_id: 'a1', user_id: 'u1', phone_number_id: 'PNID-1', access_token: 'x' },
      { id: 'b', account_id: 'a2', user_id: 'u2', phone_number_id: 'PNID-1', access_token: 'y' },
    ]
    const raw = JSON.stringify(inboundMessageBody('PNID-1'))
    const res = await postRequest(raw, sign(raw))

    expect(res.status).toBe(401)
    await flushAfter()
    expect(h.calls.inserts.messages).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cross-tenant forgery guard (§4.1.2) — THE tenancy regression test.
// Every manual client owns their Meta app and knows their own App Secret, so
// a client can forge and validly sign a payload carrying another tenant's
// number. If this ever regresses, any manual client can write into any other
// workspace's inbox.
// ---------------------------------------------------------------------------
const SECRET_A = 'app-secret-A'
const SECRET_B = 'app-secret-B'

function configA() {
  return {
    id: 'cfg-A',
    account_id: 'acct-A',
    user_id: 'user-A',
    phone_number_id: 'PNID-A',
    waba_id: 'WABA-A',
    access_token: encrypt('token-A'),
    app_secret: encrypt(SECRET_A),
  }
}
function configB() {
  return {
    id: 'cfg-B',
    account_id: 'acct-B',
    user_id: 'user-B',
    phone_number_id: 'PNID-B',
    waba_id: 'WABA-B',
    access_token: encrypt('token-B'),
    app_secret: encrypt(SECRET_B),
  }
}

function messageChange(
  phoneNumberId: string,
  opts: { wamid: string; name: string; wa: string; body: string },
) {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: phoneNumberId, phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: opts.name }, wa_id: opts.wa }],
      messages: [
        { id: opts.wamid, from: opts.wa, timestamp: '1700000000', type: 'text', text: { body: opts.body } },
      ],
    },
  }
}

describe('POST /api/whatsapp/webhook — cross-tenant forgery guard (§4.1.2)', () => {
  it("processes A's change but SKIPS a B change smuggled into a delivery validly signed with A's secret", async () => {
    h.state.configs = [configA(), configB()]
    // processMessage for A needs a conversation + contact in A's account.
    h.state.conversation = { id: 'conv-A', account_id: 'acct-A', contact_id: 'contact-A', unread_count: 0 }
    h.state.existingContact = { id: 'contact-A', name: 'Alice', account_id: 'acct-A' }

    // First change is A's number (delivery verifies with A's secret); second
    // change smuggles B's number.
    const body = {
      entry: [
        {
          id: 'WABA-A',
          changes: [
            messageChange('PNID-A', { wamid: 'wamid.A', name: 'Alice', wa: '111', body: 'from A' }),
            messageChange('PNID-B', { wamid: 'wamid.B', name: 'Bob', wa: '222', body: 'forged into B' }),
          ],
        },
      ],
    }
    const raw = JSON.stringify(body)
    const res = await postRequest(raw, sign(raw, SECRET_A)) // validly signed by A

    expect(res.status).toBe(200)
    await flushAfter()

    const inserts = h.calls.inserts.messages ?? []
    // Exactly A's message landed; B's was skipped by the id-match check.
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ conversation_id: 'conv-A', message_id: 'wamid.A' })
    expect(inserts.some((m) => m.message_id === 'wamid.B')).toBe(false)
  })

  it('does not let entry.id spoofing route B\'s number through A\'s signature (per-change phone resolution, not entry-level)', async () => {
    h.state.configs = [configA(), configB()]
    // The only change carries B's number, but entry.id is A's WABA and it is
    // signed with A's secret — an entry-level check would wave it through.
    // Per-change resolution picks B (by phone_number_id) as the verifying
    // connection, so A's signature fails against B's secret → 401.
    const body = {
      entry: [
        {
          id: 'WABA-A',
          changes: [messageChange('PNID-B', { wamid: 'wamid.B', name: 'Bob', wa: '222', body: 'forged' })],
        },
      ],
    }
    const raw = JSON.stringify(body)
    const res = await postRequest(raw, sign(raw, SECRET_A))

    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
    await flushAfter()
    expect(h.calls.inserts.messages).toBeUndefined()
  })
})

// A status change now resolves its connection first (by phone_number_id),
// and the messages mirror is scoped to that account's rows (§4.4 / 8.5).
const STATUS_CONFIG = {
  id: 'cfg-s',
  account_id: 'acct-1',
  user_id: 'user-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc',
}

describe('POST /api/whatsapp/webhook — status updates (scoped, §4.4)', () => {
  beforeEach(() => {
    h.state.configs = [STATUS_CONFIG]
    h.state.ownMessageRows = [{ id: 'msg-A', conversation_id: 'conv-1' }]
  })

  it('mirrors a delivered status onto the account\'s own rows (scoped by id, not message_id) and advances the broadcast recipient', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'sent' }
    const raw = JSON.stringify(statusBody({ status: 'delivered' }))
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(200)
    await flushAfter()

    const msgUpdates = h.calls.updates.messages ?? []
    expect(msgUpdates).toHaveLength(1)
    expect(msgUpdates[0].payload).toMatchObject({ status: 'delivered' })
    // The update is bounded to this account's own row ids — NOT a bare
    // message_id filter that would cross tenants (claude-00 invariant 1).
    expect(msgUpdates[0].filters).toEqual({ id__in: ['msg-A'] })
    expect(msgUpdates[0].filters).not.toHaveProperty('message_id')

    const brUpdates = h.calls.updates.broadcast_recipients ?? []
    expect(brUpdates).toHaveLength(1)
    expect(brUpdates[0].payload).toMatchObject({ status: 'delivered' })
    expect(brUpdates[0].payload.delivered_at).toBeTruthy()
  })

  it('touches no message rows when the resolved account owns none with that message_id', async () => {
    h.state.ownMessageRows = []
    const raw = JSON.stringify(statusBody({ status: 'delivered' }))
    await postRequest(raw, sign(raw))
    await flushAfter()
    expect(h.calls.updates.messages).toBeUndefined()
  })

  it('rejects (401) a status whose connection cannot be resolved (no write at all)', async () => {
    h.state.configs = []
    const raw = JSON.stringify(statusBody({ status: 'delivered' }))
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(401)
    await flushAfter()
    expect(h.calls.updates.messages).toBeUndefined()
    expect(h.calls.updates.broadcast_recipients).toBeUndefined()
  })

  it('stamps sent_at on a sent status from pending', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'pending' }
    const raw = JSON.stringify(statusBody({ status: 'sent' }))
    await postRequest(raw, sign(raw))
    await flushAfter()
    const brUpdates = h.calls.updates.broadcast_recipients ?? []
    expect(brUpdates[0].payload).toMatchObject({ status: 'sent' })
    expect(brUpdates[0].payload.sent_at).toBeTruthy()
  })

  it('stamps read_at on a read status from delivered', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'delivered' }
    const raw = JSON.stringify(statusBody({ status: 'read' }))
    await postRequest(raw, sign(raw))
    await flushAfter()
    const brUpdates = h.calls.updates.broadcast_recipients ?? []
    expect(brUpdates[0].payload).toMatchObject({ status: 'read' })
    expect(brUpdates[0].payload.read_at).toBeTruthy()
  })

  it('accepts failed from sent', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'sent' }
    const raw = JSON.stringify(statusBody({ status: 'failed' }))
    await postRequest(raw, sign(raw))
    await flushAfter()
    const brUpdates = h.calls.updates.broadcast_recipients ?? []
    expect(brUpdates).toHaveLength(1)
    expect(brUpdates[0].payload).toMatchObject({ status: 'failed' })
  })

  it('forward-only guard: a delivered status does not regress a recipient already read', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'read' }
    const raw = JSON.stringify(statusBody({ status: 'delivered' }))
    await postRequest(raw, sign(raw))
    await flushAfter()

    // messages is mirrored unconditionally on the account's own rows (no
    // ladder guard on that table)...
    expect(h.calls.updates.messages ?? []).toHaveLength(1)
    // ...but the broadcast recipient is NOT regressed.
    expect(h.calls.updates.broadcast_recipients).toBeUndefined()
  })

  it('forward-only guard: a failed status is refused once the recipient is delivered', async () => {
    h.state.broadcastRecipient = { id: 'br-1', status: 'delivered' }
    const raw = JSON.stringify(statusBody({ status: 'failed' }))
    await postRequest(raw, sign(raw))
    await flushAfter()
    expect(h.calls.updates.broadcast_recipients).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// §4.1.1 tenant resolution — the fallback path and its refusal to guess.
// ---------------------------------------------------------------------------
function templateEventBody(wabaId = 'WABA-1') {
  return {
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'message_template_status_update',
            value: {
              event: 'APPROVED',
              message_template_id: '123456',
              message_template_name: 'order_update',
            },
          },
        ],
      },
    ],
  }
}

describe('POST /api/whatsapp/webhook — template events resolve by waba_id (§4.1.1)', () => {
  it('resolves a template event (no metadata) via entry.id → waba_id and dispatches it', async () => {
    h.state.configs = [
      {
        id: 'cfg-1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        waba_id: 'WABA-1',
        access_token: 'enc',
      },
    ]

    const raw = JSON.stringify(templateEventBody('WABA-1'))
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(200)

    await flushAfter()
    expect(templateWebhook.handleTemplateWebhookChange).toHaveBeenCalledTimes(1)
    const arg = templateWebhook.handleTemplateWebhookChange.mock
      .calls[0][0] as unknown as { field: string }
    expect(arg.field).toBe('message_template_status_update')
  })

  it('refuses to attribute a template event when two accounts share one waba_id', async () => {
    // A real configuration — a WABA legitimately holds more than one number,
    // and a template event carries no phone_number_id to disambiguate. The
    // only safe answer is to drop it and name both accounts in the log.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.configs = [
      { id: 'a', account_id: 'acct-A', user_id: 'uA', phone_number_id: 'P-A', waba_id: 'WABA-SHARED', access_token: 'enc' },
      { id: 'b', account_id: 'acct-B', user_id: 'uB', phone_number_id: 'P-B', waba_id: 'WABA-SHARED', access_token: 'enc' },
    ]

    const raw = JSON.stringify(templateEventBody('WABA-SHARED'))
    const res = await postRequest(raw, sign(raw))

    expect(res.status).toBe(401)
    await flushAfter()
    expect(templateWebhook.handleTemplateWebhookChange).not.toHaveBeenCalled()

    const logged = errSpy.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('acct-A')
    expect(logged).toContain('acct-B')
    errSpy.mockRestore()
  })

  it('still resolves a message event by phone_number_id when waba_id is NULL', async () => {
    h.state.configs = [
      {
        id: 'cfg-1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        waba_id: null,
        access_token: encrypt('ACCESS-TOKEN'),
      },
    ]
    h.state.conversation = { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', unread_count: 0 }
    h.state.existingContact = { id: 'contact-1', name: 'Alice', account_id: 'acct-1' }

    const raw = JSON.stringify(inboundMessageBody('PNID-1'))
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(200)
    await flushAfter()
    expect(h.calls.inserts.messages ?? []).toHaveLength(1)
  })
})

describe('POST /api/whatsapp/webhook — no secret available at all (§4.1 step 3)', () => {
  it('fails closed with 401 when the connection has no app_secret and META_APP_SECRET is unset', async () => {
    const original = process.env.META_APP_SECRET
    const raw = JSON.stringify(inboundMessageBody())
    // Sign with the real secret first, then remove it — proving the rejection
    // is about having no secret to verify WITH, not a bad signature.
    const header = sign(raw, original as string)
    h.state.configs = [INBOUND_CONFIG]
    delete process.env.META_APP_SECRET
    try {
      const res = await postRequest(raw, header)
      expect(res.status).toBe(401)
      expect(h.afterCallbacks).toHaveLength(0)
    } finally {
      process.env.META_APP_SECRET = original
    }
  })
})

// ---------------------------------------------------------------------------
// §4.4 status isolation — the cross-tenant write this release fixes.
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/webhook — status isolation between accounts (§4.4)', () => {
  it("updates only the verified account's message when two accounts share a message_id", async () => {
    // Meta message ids repeat across numbers (migration 009 dropped the unique
    // constraint), so A and B can both hold a row with the SAME message_id.
    h.state.configs = [configA(), configB()]
    // The scoped lookup is filtered by conversations.account_id, so it returns
    // only A's row — B's row with the same message_id is never selected.
    h.state.ownMessageRows = [{ id: 'msg-A-row', conversation_id: 'conv-A' }]
    h.state.broadcastRecipient = null

    const body = {
      entry: [
        {
          id: 'WABA-A',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: 'x', phone_number_id: 'PNID-A' },
                statuses: [
                  { id: 'wamid.SHARED', status: 'read', timestamp: '1700000000', recipient_id: '111' },
                ],
              },
            },
          ],
        },
      ],
    }
    const raw = JSON.stringify(body)
    const res = await postRequest(raw, sign(raw, SECRET_A))
    expect(res.status).toBe(200)
    await flushAfter()

    const updates = h.calls.updates.messages ?? []
    expect(updates).toHaveLength(1)
    // Bounded to A's own row id — never a bare message_id filter, which is
    // what used to reach into B's rows.
    expect(updates[0].filters).toEqual({ id__in: ['msg-A-row'] })
    expect(updates[0].filters).not.toHaveProperty('message_id')
  })
})

describe('POST /api/whatsapp/webhook — voice notes', () => {
  const transcribe = vi.mocked(transcribeVoiceNote)

  function voiceNoteBody() {
    const body = inboundMessageBody()
    body.entry[0].changes[0].value.messages = [
      {
        id: 'wamid.VOICE',
        from: '15551112222',
        timestamp: '1700000000',
        type: 'audio',
        audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus' },
      } as never,
    ]
    return body
  }

  async function postVoiceNote() {
    h.state.configs = [
      {
        id: 'cfg1',
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: 'PNID-1',
        access_token: encrypt('ACCESS-TOKEN'),
      },
    ]
    h.state.conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      unread_count: 0,
    }
    h.state.existingContact = { id: 'contact-1', name: 'Alice', account_id: 'acct-1' }
    const raw = JSON.stringify(voiceNoteBody())
    const res = await postRequest(raw, sign(raw))
    expect(res.status).toBe(200)
  }

  it('stores the transcript as content_text and feeds it to the responders', async () => {
    transcribe.mockResolvedValueOnce({ status: 'done', transcript: 'book me in tomorrow' })
    await postVoiceNote()
    await flushAfter()

    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', mediaId: 'media-1', accessToken: 'ACCESS-TOKEN' }),
    )
    const msgUpdates = h.calls.updates.messages ?? []
    expect(msgUpdates).toHaveLength(1)
    expect(msgUpdates[0].payload).toEqual({ content_text: 'book me in tomorrow' })
    expect(msgUpdates[0].filters).toEqual({ conversation_id: 'conv-1', message_id: 'wamid.VOICE' })
    expect(h.calls.updates.conversations?.[0].payload.last_message_text).toBe('book me in tomorrow')
    expect(vi.mocked(dispatchInboundToFlows)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ kind: 'text', text: 'book me in tomorrow' }),
      }),
    )
    expect(vi.mocked(dispatchInboundToAiReply)).toHaveBeenCalled()
  })

  it('retries a failed transcription before giving up', async () => {
    vi.useFakeTimers()
    try {
      transcribe
        .mockResolvedValueOnce({ status: 'failed', error: 'timeout' })
        .mockResolvedValueOnce({ status: 'done', transcript: 'second try' })
      await postVoiceNote()
      const done = flushAfter()
      await vi.advanceTimersByTimeAsync(2000)
      await done
      expect(transcribe).toHaveBeenCalledTimes(2)
      expect(h.calls.updates.messages?.[0].payload).toEqual({ content_text: 'second try' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('behaves as before when the note cannot be transcribed', async () => {
    await postVoiceNote() // default mock: skipped
    await flushAfter()
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(h.calls.updates.messages).toBeUndefined()
    expect(h.calls.updates.conversations?.[0].payload.last_message_text).toBe('[audio]')
    expect(vi.mocked(dispatchInboundToAiReply)).not.toHaveBeenCalled()
  })
})
