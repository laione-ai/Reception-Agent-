import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolCall } from '../types'

// -------------------------------------------------------
// Hoisted mock state
// -------------------------------------------------------
const h = vi.hoisted(() => ({
  config: {
    id: 'cfg-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    clinic_name: 'Test Dental Care',
    clinic_phone: '+31612345678',
    clinic_address: '123 Test St',
    clinic_timezone: 'Europe/Amsterdam',
    reminder_initial_minutes: 720,
    reminder_final_minutes: 120,
    reminder_followup_interval: 180,
    default_duration_minutes: 30,
    demo_mode: true,
    agent_enabled: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  sendReactionCalls: [] as Array<{ accountId: string; phone: string; targetMessageId: string; emoji: string }>,
  sendReactionShouldThrow: false,
  insertedRows: [] as Array<{ table: string; data: Record<string, unknown> }>,
}))

// -------------------------------------------------------
// Mock supabase
// -------------------------------------------------------
function mockDb() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (data: Record<string, unknown>) => {
          h.insertedRows.push({ table, data })
          return { ...chain, single: () => Promise.resolve({ data, error: null }) }
        },
        update: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
      }
      return chain
    },
  } as unknown
}

// -------------------------------------------------------
// Mock WA service
// -------------------------------------------------------
function mockWaService() {
  return {
    sendTextMessage: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
    sendReaction: vi.fn(async (params: { accountId: string; phone: string; targetMessageId: string; emoji: string }) => {
      h.sendReactionCalls.push(params)
      if (h.sendReactionShouldThrow) {
        throw new Error('Simulated reaction send failure')
      }
      return { messageId: 'mock-reaction-id', messageText: params.emoji }
    }),
  }
}

// Stub dynamic imports used by other tools (prevent real imports)
vi.mock('../appointment-service', () => ({
  createAppointment: vi.fn(),
  transitionAppointment: vi.fn(),
  listAppointments: vi.fn().mockResolvedValue({ data: [] }),
}))

vi.mock('../availability-service', () => ({
  getAvailableSlots: vi.fn(),
  getNextAvailableDates: vi.fn().mockResolvedValue([]),
}))

vi.mock('../reschedule', () => ({
  commitReschedule: vi.fn(),
}))

vi.mock('../config', () => ({
  loadClinicConfig: vi.fn(),
  formatInClinicTimezone: vi.fn((iso: string) => iso),
  getDateInTimezone: vi.fn((d: Date) => d.toISOString().slice(0, 10)),
}))

import { executeTool, type ToolExecutionContext } from '../tools'

describe('react_to_message tool', () => {
  let ctx: ToolExecutionContext

  beforeEach(() => {
    h.sendReactionCalls = []
    h.sendReactionShouldThrow = false
    h.insertedRows = []

    ctx = {
      db: mockDb() as ToolExecutionContext['db'],
      accountId: 'acct-1',
      userId: 'user-1',
      phone: '+31699999999',
      patientId: 'patient-1',
      config: h.config as ToolExecutionContext['config'],
      conversationId: 'conv-1',
      waMessageId: 'wamid.HBgNMzE2MTIz',
      waService: mockWaService() as unknown as ToolExecutionContext['waService'],
    }
  })

  it('sends a reaction via waService and returns success', async () => {
    const toolCall: ToolCall = {
      id: 'tc-1',
      name: 'react_to_message',
      arguments: { emoji: '👍' },
    }

    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)

    expect(content.success).toBe(true)
    expect(content.emoji).toBe('👍')
    expect(h.sendReactionCalls).toHaveLength(1)
    expect(h.sendReactionCalls[0]).toEqual({
      accountId: 'acct-1',
      phone: '+31699999999',
      targetMessageId: 'wamid.HBgNMzE2MTIz',
      emoji: '👍',
    })
  })

  it('returns success even when sendReaction throws (non-blocking)', async () => {
    h.sendReactionShouldThrow = true

    const toolCall: ToolCall = {
      id: 'tc-2',
      name: 'react_to_message',
      arguments: { emoji: '✅' },
    }

    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)

    // Must return success despite the failure — reactions are a nice-to-have
    expect(content.success).toBe(true)
    expect(content.emoji).toBe('✅')
  })

  it('returns error when emoji is missing', async () => {
    const toolCall: ToolCall = {
      id: 'tc-3',
      name: 'react_to_message',
      arguments: {},
    }

    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)

    expect(content.error).toBeDefined()
    expect(content.error).toContain('emoji is required')
    expect(h.sendReactionCalls).toHaveLength(0)
  })

  it('targets the current inbound message (waMessageId)', async () => {
    ctx.waMessageId = 'wamid.SPECIFIC_MESSAGE_ID'

    const toolCall: ToolCall = {
      id: 'tc-4',
      name: 'react_to_message',
      arguments: { emoji: '🦷' },
    }

    await executeTool(toolCall, ctx)

    expect(h.sendReactionCalls[0].targetMessageId).toBe('wamid.SPECIFIC_MESSAGE_ID')
  })
})
