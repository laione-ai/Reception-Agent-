import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config', () => ({
  formatInClinicTimezone: vi.fn().mockImplementation(
    (date: string) => new Date(date).toLocaleDateString('en-GB'),
  ),
}))

vi.mock('@/lib/ai/defaults', () => ({
  HANDOFF_SENTINEL: '[[HANDOFF]]',
}))

import { buildDentalAgentPrompt } from '../prompt'
import type { DentalClinicConfig, DentalAppointment, DentalDoctor } from '../../types'

const mockConfig: DentalClinicConfig = {
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  clinic_name: 'Amsterdam Dental Care',
  clinic_phone: '+31612345678',
  clinic_address: '123 Keizersgracht',
  clinic_timezone: 'Europe/Amsterdam',
  reminder_initial_minutes: 720,
  reminder_final_minutes: 120,
  reminder_followup_interval: 180,
  default_duration_minutes: 30,
  demo_mode: true,
  agent_enabled: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

const mockDoctors: DentalDoctor[] = [
  {
    id: 'doc-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    full_name: 'Smith',
    specialization: 'General',
    phone: null,
    email: null,
    avatar_url: null,
    is_active: true,
    default_hours: {
      mon: { start: '09:00', end: '17:00' },
      tue: { start: '09:00', end: '17:00' },
      wed: { start: '09:00', end: '17:00' },
      thu: { start: '09:00', end: '17:00' },
      fri: { start: '09:00', end: '17:00' },
      sat: null,
      sun: null,
    },
    slot_duration_minutes: 30,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
]

describe('buildDentalAgentPrompt', () => {
  it('includes clinic name', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: mockDoctors,
    })
    expect(prompt).toContain('Amsterdam Dental Care')
  })

  it('includes clinic phone when set', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: mockDoctors,
    })
    expect(prompt).toContain('+31612345678')
  })

  it('lists active providers', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: mockDoctors,
    })
    expect(prompt).toContain('Dr. Smith')
    expect(prompt).toContain('General')
  })

  it('includes patient name when provided', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
      patientName: 'Jan de Vries',
    })
    expect(prompt).toContain('Jan de Vries')
  })

  it('says no upcoming appointments when empty', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
    })
    expect(prompt).toContain('no upcoming appointments')
  })

  it('includes anti-hallucination clause', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
    })
    expect(prompt).toContain('Never invent or fabricate')
  })

  it('includes prompt injection defense', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
    })
    expect(prompt).toContain('untrusted content')
  })

  it('includes tool usage instructions', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
    })
    expect(prompt).toContain('get_provider_availability')
    expect(prompt).toContain('get_my_appointments')
    expect(prompt).toContain('create_booking')
  })

  it('includes handoff instructions', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
    })
    expect(prompt).toContain('transfer_to_human')
  })

  it('includes the earlier-conversation summary when given', () => {
    const prompt = buildDentalAgentPrompt({
      config: mockConfig,
      patientAppointments: [],
      doctors: [],
      conversationSummary: 'Patient prefers morning slots with Dr. Smith.',
    })
    expect(prompt).toContain('Summary of earlier conversation with this patient')
    expect(prompt).toContain('Patient prefers morning slots with Dr. Smith.')
  })

  it('omits the summary section when there is no summary', () => {
    for (const conversationSummary of [undefined, null, '  ']) {
      const prompt = buildDentalAgentPrompt({
        config: mockConfig,
        patientAppointments: [],
        doctors: [],
        conversationSummary,
      })
      expect(prompt).not.toContain('Summary of earlier conversation')
    }
  })
})
