// ============================================================
// Dental Clinic — TypeScript type definitions.
//
// Mirrors the database schema from 040_dental_clinic.sql.
// All timestamps are ISO 8601 strings (UTC) — the presentation
// layer converts to Europe/Amsterdam via the clinic timezone.
// ============================================================

// -------------------------------------------------------
// Enums
// -------------------------------------------------------

export type DentalAppointmentStatus =
  | 'scheduled'
  | 'reminder_sent'
  | 'confirmed'
  | 'cancelled'
  | 'reschedule_requested'
  | 'rescheduled'
  | 'completed'
  | 'no_show';

export type DentalReminderStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export type DentalReminderType =
  | 'initial_12h'
  | 'follow_up'
  | 'final_2h';

// -------------------------------------------------------
// Clinic Configuration
// -------------------------------------------------------

export interface DentalClinicConfig {
  id: string;
  account_id: string;
  user_id: string;
  clinic_name: string;
  clinic_phone: string | null;
  clinic_address: string | null;
  clinic_timezone: string;
  reminder_initial_minutes: number;
  reminder_final_minutes: number;
  reminder_followup_interval: number;
  default_duration_minutes: number;
  demo_mode: boolean;
  /** Master switch for the AI receptionist agent. */
  agent_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Doctor
// -------------------------------------------------------

export interface DayHours {
  start: string; // "09:00"
  end: string;   // "17:00"
}

export type WeeklyHours = {
  [key in 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun']: DayHours | null;
};

export interface DentalDoctor {
  id: string;
  account_id: string;
  user_id: string;
  full_name: string;
  specialization: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  is_active: boolean;
  default_hours: WeeklyHours;
  slot_duration_minutes: number;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Patient
// -------------------------------------------------------

export interface DentalPatient {
  id: string;
  account_id: string;
  user_id: string;
  contact_id: string | null;
  full_name: string;
  /** True when the patient has explicitly confirmed their name (not auto-pulled). */
  name_confirmed: boolean;
  phone: string;
  email: string | null;
  date_of_birth: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Doctor Availability Override
// -------------------------------------------------------

export interface BreakPeriod {
  start: string; // "12:00"
  end: string;   // "13:00"
}

export interface DentalDoctorAvailability {
  id: string;
  doctor_id: string;
  account_id: string;
  available_date: string; // "YYYY-MM-DD"
  start_time: string | null;
  end_time: string | null;
  breaks: BreakPeriod[];
  reason: string | null;
  created_at: string;
}

// -------------------------------------------------------
// Appointment
// -------------------------------------------------------

export interface DentalAppointment {
  id: string;
  account_id: string;
  user_id: string;
  patient_id: string;
  doctor_id: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: DentalAppointmentStatus;
  treatment_type: string | null;
  notes: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  completed_at: string | null;
  conversation_id: string | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  last_reminder_sent_at: string | null;
  reminder_count: number;
  patient_responded: boolean;
  patient_response_at: string | null;
  /** How this appointment was created: 'staff' | 'agent' | 'button'. */
  booked_via: string;
  /** Stable UID for .ics calendar events — survives reschedules. */
  calendar_uid: string | null;
  created_at: string;
  updated_at: string;

  // Joined fields (optional — populated by queries with joins)
  patient?: DentalPatient;
  doctor?: DentalDoctor;
  reminders?: DentalAppointmentReminder[];
}

// -------------------------------------------------------
// Reminder
// -------------------------------------------------------

export interface DentalAppointmentReminder {
  id: string;
  appointment_id: string;
  account_id: string;
  reminder_type: DentalReminderType;
  status: DentalReminderStatus;
  scheduled_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  whatsapp_message_id: string | null;
  error_message: string | null;
  sequence_number: number;
  created_at: string;
}

// -------------------------------------------------------
// Audit
// -------------------------------------------------------

export interface DentalAppointmentAudit {
  id: string;
  appointment_id: string;
  account_id: string;
  action: string;
  old_status: string | null;
  new_status: string | null;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

// -------------------------------------------------------
// Reschedule Session
// -------------------------------------------------------

export type RescheduleStep =
  | 'date_selection'
  | 'time_selection'
  | 'confirmation'
  | 'completed';

export interface DentalRescheduleSession {
  id: string;
  appointment_id: string;
  account_id: string;
  patient_id: string;
  step: RescheduleStep;
  offered_dates: string[] | null;
  selected_date: string | null;
  offered_slots: string[] | null;
  selected_slot: string | null;
  new_starts_at: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
}

// -------------------------------------------------------
// Message Log
// -------------------------------------------------------

export interface DentalMessageLog {
  id: string;
  account_id: string;
  appointment_id: string | null;
  patient_id: string | null;
  direction: 'outbound' | 'inbound';
  message_type: 'text' | 'interactive' | 'template';
  content: string | null;
  interactive_payload: Record<string, unknown> | null;
  whatsapp_message_id: string | null;
  mock_mode: boolean;
  created_at: string;
}

// -------------------------------------------------------
// API Request/Response types
// -------------------------------------------------------

export interface CreateAppointmentRequest {
  patient_id: string;
  doctor_id: string;
  starts_at: string;
  duration_minutes?: number;
  treatment_type?: string;
  notes?: string;
}

export interface AvailableSlot {
  time: string;     // "09:00"
  datetime: string;  // Full ISO string in clinic timezone
  available: boolean;
}

export interface DayAvailability {
  date: string;      // "2024-01-15"
  day_name: string;  // "Monday"
  slots: AvailableSlot[];
}

// -------------------------------------------------------
// WhatsApp interactive button IDs
// Prefixed with 'dental_' so the webhook handler can route
// them to the dental system without collisions.
// -------------------------------------------------------

export const DENTAL_BUTTON_PREFIX = 'dental_' as const;

export const DENTAL_BUTTON_IDS = {
  CONFIRM: 'dental_confirm',
  CANCEL: 'dental_cancel',
  RESCHEDULE: 'dental_reschedule',
  // Reschedule flow — date selection (dental_date_0, dental_date_1, dental_date_2)
  DATE_PREFIX: 'dental_date_',
  // Reschedule flow — slot selection (dental_slot_0, dental_slot_1, ...)
  SLOT_PREFIX: 'dental_slot_',
  // Reschedule flow — confirm new slot
  RESCHEDULE_CONFIRM: 'dental_resched_confirm',
  RESCHEDULE_CANCEL: 'dental_resched_cancel',
} as const;

// -------------------------------------------------------
// State machine — valid transitions
// -------------------------------------------------------

export const VALID_STATUS_TRANSITIONS: Record<
  DentalAppointmentStatus,
  DentalAppointmentStatus[]
> = {
  scheduled: ['reminder_sent', 'confirmed', 'cancelled', 'reschedule_requested', 'completed'],
  reminder_sent: ['confirmed', 'cancelled', 'reschedule_requested', 'completed', 'no_show'],
  confirmed: ['cancelled', 'reschedule_requested', 'completed', 'no_show'],
  cancelled: [],
  reschedule_requested: ['rescheduled', 'cancelled'],
  rescheduled: [],
  completed: [],
  no_show: [],
};

// -------------------------------------------------------
// Agent Session
// -------------------------------------------------------

export type DentalAgentIntent =
  | 'book'
  | 'cancel'
  | 'reschedule'
  | 'check_status'
  | 'faq_or_other';

export type DentalAgentState =
  | 'awaiting_intent'
  | 'collecting_info'
  | 'confirming'
  | 'executing'
  | 'completed'
  | 'expired'
  | 'handed_off';

export interface DentalAgentSessionSlots {
  doctor_id?: string;
  doctor_name?: string;
  treatment_type?: string;
  preferred_date?: string;
  preferred_time?: string;
  appointment_id?: string;
  offered_options?: Array<{ id: string; label: string; value: string }>;
  candidate_starts_at?: string;
  new_doctor_id?: string;
}

export interface DentalAgentSession {
  id: string;
  account_id: string;
  patient_id: string | null;
  conversation_id: string | null;
  phone: string;
  intent: DentalAgentIntent | null;
  state: DentalAgentState;
  slots: DentalAgentSessionSlots;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  turn_count: number;
  last_message_id: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
