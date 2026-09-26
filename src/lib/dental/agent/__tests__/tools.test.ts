import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolCall } from '../types'

// -------------------------------------------------------
// Hoisted mock state
// -------------------------------------------------------
const h = vi.hoisted(() => ({
  doctors: [] as Array<{ id: string; full_name: string; specialization: string | null; is_active: boolean }>,
  appointments: [] as Array<Record<string, unknown>>,
  patient: null as { id: string; full_name: string } | null,
  session: null as Record<string, unknown> | null,
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
  insertedRows: [] as Array<{ table: string; data: Record<string, unknown> }>,
  updatedRows: [] as Array<{ table: string; data: Record<string, unknown> }>,
  transitionCalls: [] as Array<{ appointmentId: string; status: string; actor: string }>,
  createAppointmentResult: null as Record<string, unknown> | null,
  commitRescheduleResult: null as Record<string, unknown> | null,
  availableSlots: [] as Array<Record<string, unknown>>,
  nextDates: [] as string[],
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
        update: (data: Record<string, unknown>) => {
          h.updatedRows.push({ table, data })
          return chain
        },
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (table === 'dental_patients') {
            return Promise.resolve({ data: h.patient, error: null })
          }
          if (table === 'dental_clinic_config') {
            return Promise.resolve({ data: h.config, error: null })
          }
          if (table === 'dental_agent_sessions') {
            return Promise.resolve({ data: h.session, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        single: () => {
          if (table === 'dental_appointments') {
            return Promise.resolve({ data: h.appointments[0] ?? null, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
      }
      // For queries returning arrays
      if (table === 'dental_doctors') {
        return {
          ...chain,
          then: undefined,
          [Symbol.toStringTag]: 'Promise',
        }
      }
      return chain
    },
  } as unknown
}

// -------------------------------------------------------
// Mock modules
// -------------------------------------------------------
vi.mock('../appointment-service', () => ({
  createAppointment: vi.fn().mockImplementation(() => {
    if (h.createAppointmentResult) return h.createAppointmentResult
    return {
      id: 'appt-new',
      starts_at: '2024-02-01T09:00:00Z',
      ends_at: '2024-02-01T09:30:00Z',
      duration_minutes: 30,
      status: 'scheduled',
      treatment_type: null,
      doctor: { full_name: 'Smith' },
      booked_via: 'agent',
      calendar_uid: null,
    }
  }),
  transitionAppointment: vi.fn().mockImplementation(
    (_db: unknown, _accountId: string, appointmentId: string, status: string, actor: string) => {
      h.transitionCalls.push({ appointmentId, status, actor })
      return {
        id: appointmentId,
        status,
        starts_at: '2024-02-01T09:00:00Z',
        ends_at: '2024-02-01T09:30:00Z',
        duration_minutes: 30,
        doctor: { full_name: 'Smith' },
      }
    },
  ),
  listAppointments: vi.fn().mockImplementation(() => ({
    data: h.appointments,
    count: h.appointments.length,
  })),
}))

vi.mock('../availability-service', () => ({
  getAvailableSlots: vi.fn().mockImplementation(() => h.availableSlots),
  getNextAvailableDates: vi.fn().mockImplementation(() => h.nextDates),
}))

vi.mock('../reschedule', () => ({
  commitReschedule: vi.fn().mockImplementation(() => {
    if (h.commitRescheduleResult) return h.commitRescheduleResult
    return {
      newAppointment: {
        id: 'appt-rescheduled',
        starts_at: '2024-02-05T10:00:00Z',
        ends_at: '2024-02-05T10:30:00Z',
        duration_minutes: 30,
        status: 'confirmed',
        doctor: { full_name: 'Smith' },
        treatment_type: null,
      },
    }
  }),
}))

vi.mock('../config', () => ({
  loadClinicConfig: vi.fn().mockImplementation(() => h.config),
  formatInClinicTimezone: vi.fn().mockImplementation(
    (date: string) => new Date(date).toLocaleDateString('en-GB'),
  ),
  getDateInTimezone: vi.fn().mockImplementation(
    (date: Date) => date.toISOString().slice(0, 10),
  ),
}))

import { executeTool, DENTAL_TOOLS } from '../tools'
import type { ToolExecutionContext } from '../tools'

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('DENTAL_TOOLS', () => {
  it('defines exactly 8 tools', () => {
    expect(DENTAL_TOOLS).toHaveLength(8)
  })

  it('all tools have name, description, and parameters', () => {
    for (const tool of DENTAL_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters.type).toBe('object')
    }
  })

  it('tool names are unique', () => {
    const names = DENTAL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('executeTool', () => {
  let ctx: ToolExecutionContext

  beforeEach(() => {
    h.doctors = [
      { id: 'doc-1', full_name: 'Smith', specialization: 'General', is_active: true },
      { id: 'doc-2', full_name: 'Jones', specialization: 'Orthodontics', is_active: true },
    ]
    h.appointments = []
    h.patient = { id: 'pat-1', full_name: 'John Doe' }
    h.insertedRows = []
    h.updatedRows = []
    h.transitionCalls = []
    h.createAppointmentResult = null
    h.commitRescheduleResult = null
    h.availableSlots = [
      {
        date: '2024-02-01',
        day_name: 'Thursday',
        slots: [
          { time: '09:00', datetime: '2024-02-01T08:00:00Z', available: true },
          { time: '09:30', datetime: '2024-02-01T08:30:00Z', available: true },
          { time: '10:00', datetime: '2024-02-01T09:00:00Z', available: false },
        ],
      },
    ]
    h.nextDates = ['2024-02-01']

    ctx = {
      db: mockDb() as ToolExecutionContext['db'],
      accountId: 'acct-1',
      userId: 'user-1',
      phone: '+31612345678',
      patientId: 'pat-1',
      config: h.config as ToolExecutionContext['config'],
      conversationId: 'conv-1',
    }
  })

  it('list_providers returns providers', async () => {
    const toolCall: ToolCall = { id: 'tc-1', name: 'list_providers', arguments: {} }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.providers).toBeDefined()
    expect(result.tool_call_id).toBe('tc-1')
  })

  it('get_my_appointments returns error when no patient', async () => {
    ctx.patientId = null
    const toolCall: ToolCall = { id: 'tc-2', name: 'get_my_appointments', arguments: {} }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toBeDefined()
    expect(content.error).toContain('No patient record')
  })

  it('cancel_booking enforces ownership', async () => {
    const toolCall: ToolCall = {
      id: 'tc-3',
      name: 'cancel_booking',
      arguments: { appointment_id: 'appt-999' },
    }
    // With patientId null → should fail ownership
    ctx.patientId = null
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toBeDefined()
    expect(content.error).toContain('does not belong')
  })

  it('cancel_booking requires appointment_id', async () => {
    const toolCall: ToolCall = {
      id: 'tc-4',
      name: 'cancel_booking',
      arguments: {},
    }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toContain('appointment_id is required')
  })

  it('create_booking requires doctor_id and starts_at', async () => {
    const toolCall: ToolCall = {
      id: 'tc-5',
      name: 'create_booking',
      arguments: { doctor_id: 'doc-1' }, // missing starts_at
    }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toContain('required')
  })

  it('create_booking fails when no patient', async () => {
    ctx.patientId = null
    const toolCall: ToolCall = {
      id: 'tc-6',
      name: 'create_booking',
      arguments: { doctor_id: 'doc-1', starts_at: '2024-02-01T09:00:00Z' },
    }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toContain('Cannot book')
  })

  it('transfer_to_human sets handoff flag', async () => {
    const toolCall: ToolCall = {
      id: 'tc-7',
      name: 'transfer_to_human',
      arguments: { reason: 'Patient asked for a human' },
    }
    const { result, handoff } = await executeTool(toolCall, ctx)
    expect(handoff).toBe(true)
    const content = JSON.parse(result.content)
    expect(content.success).toBe(true)
  })

  it('unknown tool returns error', async () => {
    const toolCall: ToolCall = {
      id: 'tc-8',
      name: 'nonexistent_tool',
      arguments: {},
    }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toContain('Unknown tool')
  })

  it('reschedule_booking requires both appointment_id and new_starts_at', async () => {
    const toolCall: ToolCall = {
      id: 'tc-9',
      name: 'reschedule_booking',
      arguments: { appointment_id: 'appt-1' }, // missing new_starts_at
    }
    const { result } = await executeTool(toolCall, ctx)
    const content = JSON.parse(result.content)
    expect(content.error).toContain('required')
  })
})
