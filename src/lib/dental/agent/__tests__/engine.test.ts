import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(),
}))

vi.mock('@/lib/ai/defaults', () => ({
  aiRequestTimeoutMs: () => 10_000,
}))

vi.mock('../providers', () => ({
  generateWithTools: vi.fn(),
}))

vi.mock('../tools', () => ({
  DENTAL_TOOLS: [],
  executeTool: vi.fn(),
}))

vi.mock('../prompt', () => ({
  buildDentalAgentPrompt: vi.fn(() => 'SYSTEM PROMPT'),
}))

vi.mock('../memory', () => ({
  loadAgentMemory: vi.fn(),
}))

vi.mock('../session', () => ({
  loadActiveSession: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  completeSession: vi.fn(),
  isSessionExpired: vi.fn(() => false),
  isMessageAlreadyProcessed: vi.fn(() => false),
}))

vi.mock('../../config', () => ({
  loadClinicConfig: vi.fn(async () => ({ clinic_name: 'Test Dental', clinic_timezone: 'UTC' })),
  formatInClinicTimezone: vi.fn(() => ''),
}))

vi.mock('../../calendar', () => ({
  formatCalendarLinksForWhatsApp: vi.fn(() => ''),
}))

import { runAgentTurn } from '../engine'
import { loadAiConfig } from '@/lib/ai/config'
import { generateWithTools } from '../providers'
import { buildDentalAgentPrompt } from '../prompt'
import { loadAgentMemory } from '../memory'
import { loadActiveSession, completeSession } from '../session'
import { loadClinicConfig } from '../../config'
import type { ToolCallingMessage } from '../types'

/** Minimal chainable Supabase stub: every query resolves to per-table data. */
function makeDb(tables: Record<string, unknown> = {}) {
  const from = vi.fn((table: string) => {
    const result = { data: tables[table] ?? null, error: null }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'insert', 'update']) {
      chain[m] = () => chain
    }
    chain.maybeSingle = async () => result
    chain.single = async () => result
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  })
  return { from } as unknown as SupabaseClient & { from: typeof from }
}

const ctx = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  phone: '+31612345678',
  configOwnerUserId: 'user-1',
}

function sentMessages(): ToolCallingMessage[] {
  return vi.mocked(generateWithTools).mock.calls[0][1].messages
}

beforeEach(() => {
  vi.mocked(loadAiConfig).mockResolvedValue({
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    handoffAgentId: null,
  } as unknown as Awaited<ReturnType<typeof loadAiConfig>>)
  vi.mocked(loadActiveSession).mockResolvedValue({
    id: 'sess-1',
    patient_id: 'pat-1',
    state: 'collecting_info',
    // Only used as a fallback (demo mode / failed history load).
    messages: [{ role: 'user', content: 'SESSION ONLY' }],
    turn_count: 1,
    last_message_id: null,
  } as unknown as Awaited<ReturnType<typeof loadActiveSession>>)
})

const db = () =>
  makeDb({
    dental_doctors: [],
    dental_patients: { id: 'pat-1', full_name: 'Jane Doe', name_confirmed: true },
    dental_appointments: [],
  })

describe('runAgentTurn — memory context', () => {
  it('uses memory history + summary and does not duplicate the persisted inbound message', async () => {
    vi.mocked(loadAgentMemory).mockResolvedValue({
      summary: 'Patient prefers mornings.',
      history: [
        { role: 'user', content: 'Hi, I booked a cleaning last week' },
        { role: 'assistant', content: 'Great, see you then!' },
        { role: 'user', content: 'Can I move it?' },
      ],
    })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: 'Sure, which day works?', toolCalls: [], usage: null, done: true,
    })

    const result = await runAgentTurn(db(), ctx, 'Can I move it?', 'wamid-1')

    expect(loadAgentMemory).toHaveBeenCalledWith(expect.anything(), 'conv-1')
    expect(vi.mocked(buildDentalAgentPrompt).mock.calls[0][0].conversationSummary)
      .toBe('Patient prefers mornings.')
    expect(sentMessages()).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'Hi, I booked a cleaning last week' },
      { role: 'assistant', content: 'Great, see you then!' },
      { role: 'user', content: 'Can I move it?' },
    ])
    expect(result).toMatchObject({ consumed: true, reply: 'Sure, which day works?', handedOff: false })
    expect(result.ai).toEqual({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })
  })

  it('appends the inbound message when it is not yet in history', async () => {
    vi.mocked(loadAgentMemory).mockResolvedValue({
      summary: null,
      history: [{ role: 'assistant', content: 'How can I help?' }],
    })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: 'Hello!', toolCalls: [], usage: null, done: true,
    })

    await runAgentTurn(db(), ctx, 'Hello', 'wamid-2')

    expect(sentMessages().slice(1)).toEqual([
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'Hello' },
    ])
  })

  it('does not duplicate a persisted voice note', async () => {
    vi.mocked(loadAgentMemory).mockResolvedValue({
      summary: null,
      history: [{ role: 'user', content: '[Voice note] I need an appointment tomorrow' }],
    })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: 'Sure!', toolCalls: [], usage: null, done: true,
    })

    await runAgentTurn(db(), ctx, '[Voice note] I need an appointment tomorrow', 'wamid-3')

    expect(sentMessages().slice(1)).toEqual([
      { role: 'user', content: '[Voice note] I need an appointment tomorrow' },
    ])
  })

  it('falls back to the session transcript when history is empty', async () => {
    vi.mocked(loadAgentMemory).mockResolvedValue({ summary: null, history: [] })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: 'Hi!', toolCalls: [], usage: null, done: true,
    })

    await runAgentTurn(db(), ctx, 'Hello', 'wamid-4')

    expect(sentMessages().slice(1)).toEqual([
      { role: 'user', content: 'SESSION ONLY' },
      { role: 'user', content: 'Hello' },
    ])
  })

  it('uses the session transcript in demo mode (agent replies are not persisted there)', async () => {
    vi.mocked(loadClinicConfig).mockResolvedValueOnce({
      clinic_name: 'Test Dental', clinic_timezone: 'UTC', demo_mode: true,
    } as unknown as Awaited<ReturnType<typeof loadClinicConfig>>)
    vi.mocked(loadAgentMemory).mockResolvedValue({
      summary: null,
      history: [{ role: 'user', content: 'Hello' }],
    })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: 'Hi!', toolCalls: [], usage: null, done: true,
    })

    await runAgentTurn(db(), ctx, 'Hello', 'wamid-5')

    expect(sentMessages().slice(1)).toEqual([
      { role: 'user', content: 'SESSION ONLY' },
      { role: 'user', content: 'Hello' },
    ])
  })
})

describe('runAgentTurn — empty model reply', () => {
  it('hands off with the technical-difficulties message instead of staying silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(loadAgentMemory).mockResolvedValue({ summary: null, history: [] })
    vi.mocked(generateWithTools).mockResolvedValue({
      text: '', toolCalls: [], usage: null, done: true,
    })

    const result = await runAgentTurn(db(), ctx, 'Hello?', 'wamid-4')

    expect(result.consumed).toBe(true)
    expect(result.handedOff).toBe(true)
    expect(result.reply).toMatch(/technical difficulties/)
    expect(completeSession).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'handed_off')
  })
})
