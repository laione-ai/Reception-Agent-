// ============================================================
// Dental Agent — Tool definitions and server-side executors.
//
// Each tool:
//   1. Has a JSON Schema definition (for the LLM)
//   2. Has a server-side executor (calls real service functions)
//   3. Enforces ownership (patient can only see/modify their own data)
//
// The LLM never writes to the database directly — every mutation
// goes through the existing deterministic service layer.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDefinition, ToolResult, ToolCall } from './types';
import type { DentalWhatsAppService } from '../whatsapp-service';
import type { DentalClinicConfig, DentalAppointment } from '../types';
import {
  createAppointment,
  transitionAppointment,
  listAppointments,
} from '../appointment-service';
import {
  getAvailableSlots,
  getNextAvailableDates,
} from '../availability-service';
import { commitReschedule } from '../reschedule';
import { loadClinicConfig, formatInClinicTimezone, getDateInTimezone } from '../config';

// -------------------------------------------------------
// Tool definitions (JSON Schemas for the LLM)
// -------------------------------------------------------

export const DENTAL_TOOLS: ToolDefinition[] = [
  {
    name: 'list_providers',
    description:
      'List all active dental providers/doctors at this clinic with their specialization.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_provider_availability',
    description:
      'Get available appointment slots for a specific provider on upcoming dates. Always call this to check real availability before offering times to the patient.',
    parameters: {
      type: 'object',
      properties: {
        doctor_id: {
          type: 'string',
          description: 'The provider\'s ID',
        },
        from_date: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (optional, defaults to tomorrow)',
        },
        to_date: {
          type: 'string',
          description: 'End date YYYY-MM-DD (optional, defaults to 7 days from from_date)',
        },
      },
      required: ['doctor_id'],
    },
  },
  {
    name: 'get_my_appointments',
    description:
      'Get the patient\'s own upcoming appointments. Only returns appointments belonging to the sending phone number.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_booking',
    description:
      'Book a new appointment. Only call this after confirming the slot with the patient.',
    parameters: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string', description: 'The provider\'s ID' },
        starts_at: {
          type: 'string',
          description: 'ISO 8601 UTC datetime of the slot',
        },
        duration_minutes: {
          type: 'integer',
          description: 'Optional, defaults to clinic default',
        },
        treatment_type: {
          type: 'string',
          description: 'Optional treatment type/reason for visit',
        },
      },
      required: ['doctor_id', 'starts_at'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing appointment. The patient must confirm before calling this.',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'The appointment ID' },
        reason: {
          type: 'string',
          description: 'Optional cancellation reason',
        },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Reschedule an existing appointment to a new time. Call get_provider_availability first to verify the slot is open.',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'The appointment ID' },
        new_starts_at: {
          type: 'string',
          description: 'ISO 8601 UTC datetime of the new slot',
        },
        new_doctor_id: {
          type: 'string',
          description:
            'Optional: only if the patient wants to switch providers',
        },
      },
      required: ['appointment_id', 'new_starts_at'],
    },
  },
  {
    name: 'update_patient_name',
    description:
      'Update the patient\'s full name. Call this when a new patient provides their name for the first time, especially when their current name on file is just a phone number.',
    parameters: {
      type: 'object',
      properties: {
        full_name: {
          type: 'string',
          description: 'The patient\'s full name as they provided it',
        },
      },
      required: ['full_name'],
    },
  },
  {
    name: 'transfer_to_human',
    description:
      'Hand this conversation to a human staff member. Use when: the patient explicitly asks for a human, you cannot confidently help, or after repeated failures.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for the handoff',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'react_to_message',
    description:
      'React to the patient\'s current message with an emoji. Use sparingly for quick acknowledgments (e.g. 👍 when starting to process a request). A failed reaction never blocks the turn.',
    parameters: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description: 'A single emoji to react with (e.g. "👍", "✅", "🦷")',
        },
      },
      required: ['emoji'],
    },
  },
];

// -------------------------------------------------------
// Tool execution context
// -------------------------------------------------------

export interface ToolExecutionContext {
  db: SupabaseClient;
  accountId: string;
  userId: string;       // config owner for audit/FK compliance
  phone: string;        // patient's phone — for ownership checks
  patientId: string | null;
  config: DentalClinicConfig;
  conversationId: string;
  /** Meta message_id of the current inbound message (for react_to_message). */
  waMessageId: string;
  /** WhatsApp service instance for sending reactions. */
  waService: DentalWhatsAppService;
}

// -------------------------------------------------------
// Server-side tool executor
// -------------------------------------------------------

/**
 * Execute a tool call server-side. Every mutation goes through the
 * existing deterministic service layer. Ownership is enforced —
 * the patient can only see/modify their own data.
 *
 * Returns a ToolResult with a JSON-stringified content for the LLM,
 * or throws on unexpected errors.
 *
 * The `handoff` flag in the return indicates the conversation should
 * be handed to a human (only for transfer_to_human).
 */
export async function executeTool(
  toolCall: ToolCall,
  ctx: ToolExecutionContext,
): Promise<{ result: ToolResult; handoff?: boolean; handoffReason?: string; appointment?: DentalAppointment }> {
  const { db, accountId, userId, phone, patientId, config } = ctx;
  const args = toolCall.arguments;
  const tz = config.clinic_timezone;

  try {
    switch (toolCall.name) {
      // ====================================================
      // list_providers
      // ====================================================
      case 'list_providers': {
        const { data: doctors, error } = await db
          .from('dental_doctors')
          .select('id, full_name, specialization')
          .eq('account_id', accountId)
          .eq('is_active', true)
          .order('full_name');

        if (error) throw error;

        // Annotate with next-available date for each doctor
        const annotated = await Promise.all(
          (doctors ?? []).map(async (d) => {
            try {
              const nextDates = await getNextAvailableDates(
                db, accountId, d.id, tz, 1, config.default_duration_minutes,
              );
              return {
                id: d.id,
                name: d.full_name,
                specialization: d.specialization,
                next_available: nextDates[0] ?? null,
              };
            } catch {
              return {
                id: d.id,
                name: d.full_name,
                specialization: d.specialization,
                next_available: null,
              };
            }
          }),
        );

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ providers: annotated }),
          },
        };
      }

      // ====================================================
      // get_provider_availability
      // ====================================================
      case 'get_provider_availability': {
        const doctorId = args.doctor_id as string;
        if (!doctorId) {
          return errorResult(toolCall, 'doctor_id is required');
        }

        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const fromDate = (args.from_date as string) ?? getDateInTimezone(tomorrow, tz);
        const toDateDefault = new Date(new Date(fromDate + 'T00:00:00Z'));
        toDateDefault.setDate(toDateDefault.getDate() + 6);
        const toDate = (args.to_date as string) ?? getDateInTimezone(toDateDefault, tz);

        let availability: Awaited<ReturnType<typeof getAvailableSlots>>;
        try {
          availability = await getAvailableSlots(
            db, accountId, doctorId, fromDate, toDate, tz, config.default_duration_minutes,
          );
        } catch (availErr) {
          console.error('[dental agent] get_provider_availability error:', availErr);
          return errorResult(
            toolCall,
            `Could not fetch availability for doctor_id=${doctorId} from ${fromDate} to ${toDate}. ` +
            `This may be a temporary issue — try again, or try a different date range. ` +
            `If the doctor_id is wrong, call list_providers first to get valid IDs.`,
          );
        }

        // Filter to only available slots for a cleaner response
        const summary = availability.map((day) => ({
          date: day.date,
          day_name: day.day_name,
          available_slots: day.slots
            .filter((s) => s.available)
            .map((s) => ({ time: s.time, datetime: s.datetime })),
        })).filter((d) => d.available_slots.length > 0);

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              doctor_id: doctorId,
              from_date: fromDate,
              to_date: toDate,
              timezone: tz,
              available_days: summary,
            }),
          },
        };
      }

      // ====================================================
      // get_my_appointments
      // ====================================================
      case 'get_my_appointments': {
        if (!patientId) {
          return errorResult(toolCall, 'No patient record found for your phone number. You may need to book your first appointment.');
        }

        const { data: appointments } = await listAppointments(db, accountId, {
          patient_id: patientId,
          status: ['scheduled', 'reminder_sent', 'confirmed'],
          from_date: new Date().toISOString(),
          limit: 10,
        });

        const formatted = appointments.map((a) => ({
          id: a.id,
          date: formatInClinicTimezone(a.starts_at, tz, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          }),
          time: formatInClinicTimezone(a.starts_at, tz, {
            hour: '2-digit', minute: '2-digit', hour12: false,
          }),
          starts_at: a.starts_at,
          doctor: a.doctor?.full_name ?? 'Unknown',
          doctor_id: a.doctor_id,
          status: a.status,
          treatment_type: a.treatment_type,
          duration_minutes: a.duration_minutes,
        }));

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ appointments: formatted }),
          },
        };
      }

      // ====================================================
      // create_booking
      // ====================================================
      case 'create_booking': {
        const doctorId = args.doctor_id as string;
        const startsAt = args.starts_at as string;
        if (!doctorId || !startsAt) {
          return errorResult(toolCall, 'doctor_id and starts_at are required');
        }

        if (!patientId) {
          return errorResult(toolCall, 'Cannot book: no patient record found. The patient needs to be registered first.');
        }

        try {
          const appointment = await createAppointment(db, accountId, userId, {
            patient_id: patientId,
            doctor_id: doctorId,
            starts_at: startsAt,
            duration_minutes: args.duration_minutes as number | undefined,
            treatment_type: args.treatment_type as string | undefined,
          });

          // Update booked_via to 'agent'
          await db
            .from('dental_appointments')
            .update({ booked_via: 'agent' })
            .eq('id', appointment.id);

          // Generate calendar UID and store it
          const calendarUid = `dental-${appointment.id}@${config.clinic_name.replace(/\s+/g, '-').toLowerCase()}`;
          await db
            .from('dental_appointments')
            .update({ calendar_uid: calendarUid })
            .eq('id', appointment.id);

          appointment.booked_via = 'agent';
          appointment.calendar_uid = calendarUid;

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                appointment: {
                  id: appointment.id,
                  date: formatInClinicTimezone(appointment.starts_at, tz, {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                  }),
                  time: formatInClinicTimezone(appointment.starts_at, tz, {
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  }),
                  doctor: appointment.doctor?.full_name,
                  treatment_type: appointment.treatment_type,
                  duration_minutes: appointment.duration_minutes,
                },
              }),
            },
            appointment,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          if (message.includes('conflicts with an existing appointment')) {
            return errorResult(
              toolCall,
              'That time slot was just taken by someone else. Please check availability again and offer the patient a different slot.',
            );
          }
          return errorResult(toolCall, `Booking failed: ${message}`);
        }
      }

      // ====================================================
      // cancel_booking
      // ====================================================
      case 'cancel_booking': {
        const appointmentId = args.appointment_id as string;
        if (!appointmentId) {
          return errorResult(toolCall, 'appointment_id is required');
        }

        // Ownership check — verify this appointment belongs to this patient
        const ownershipOk = await verifyAppointmentOwnership(
          db, accountId, appointmentId, patientId,
        );
        if (!ownershipOk) {
          return errorResult(toolCall, 'Appointment not found or does not belong to this patient.');
        }

        try {
          const appointment = await transitionAppointment(
            db, accountId, appointmentId, 'cancelled', 'patient_via_agent',
            { reason: (args.reason as string) ?? 'Patient cancelled via chat' },
          );

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                cancelled_appointment: {
                  id: appointment.id,
                  date: formatInClinicTimezone(appointment.starts_at, tz, {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                  }),
                  time: formatInClinicTimezone(appointment.starts_at, tz, {
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  }),
                  doctor: appointment.doctor?.full_name,
                },
              }),
            },
            appointment,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return errorResult(toolCall, `Cancellation failed: ${message}`);
        }
      }

      // ====================================================
      // reschedule_booking
      // ====================================================
      case 'reschedule_booking': {
        const appointmentId = args.appointment_id as string;
        const newStartsAt = args.new_starts_at as string;
        if (!appointmentId || !newStartsAt) {
          return errorResult(toolCall, 'appointment_id and new_starts_at are required');
        }

        // Ownership check
        const ownerOk = await verifyAppointmentOwnership(
          db, accountId, appointmentId, patientId,
        );
        if (!ownerOk) {
          return errorResult(toolCall, 'Appointment not found or does not belong to this patient.');
        }

        // Load the old appointment with joins
        const { data: oldAppt, error: loadErr } = await db
          .from('dental_appointments')
          .select('*, patient:dental_patients(*), doctor:dental_doctors(*)')
          .eq('id', appointmentId)
          .eq('account_id', accountId)
          .single();

        if (loadErr || !oldAppt) {
          return errorResult(toolCall, 'Appointment not found.');
        }

        // Transition to reschedule_requested first (if valid)
        const rescheduleableStatuses = ['scheduled', 'reminder_sent', 'confirmed'];
        if (!rescheduleableStatuses.includes(oldAppt.status)) {
          return errorResult(toolCall, `Cannot reschedule an appointment with status: ${oldAppt.status}`);
        }

        // Only transition if not already in reschedule_requested
        if (oldAppt.status !== 'reschedule_requested') {
          try {
            await transitionAppointment(
              db, accountId, appointmentId, 'reschedule_requested', 'patient_via_agent',
            );
          } catch (err) {
            // Non-critical — may already be in this state
            console.warn('[dental agent] reschedule transition warning:', err);
          }
        }

        try {
          const { newAppointment } = await commitReschedule({
            db,
            accountId,
            oldAppointment: oldAppt as DentalAppointment,
            newStartsAt: new Date(newStartsAt),
            config,
            newDoctorId: args.new_doctor_id as string | undefined,
            actor: 'patient_via_agent',
            bookedVia: 'agent',
          });

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                new_appointment: {
                  id: newAppointment.id,
                  date: formatInClinicTimezone(newAppointment.starts_at, tz, {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                  }),
                  time: formatInClinicTimezone(newAppointment.starts_at, tz, {
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  }),
                  doctor: oldAppt.doctor?.full_name,
                  treatment_type: newAppointment.treatment_type,
                },
              }),
            },
            appointment: newAppointment,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Check for EXCLUDE constraint (23P01) — slot was taken
          const code = (err as { code?: string })?.code;
          if (code === '23P01' || message.includes('conflicts')) {
            // Revert the reschedule_requested status back
            try {
              await db
                .from('dental_appointments')
                .update({ status: 'confirmed', updated_at: new Date().toISOString() })
                .eq('id', appointmentId);
            } catch {
              // Best effort
            }
            return errorResult(
              toolCall,
              'That time slot was just taken by someone else. Please check availability again and offer the patient a different slot.',
            );
          }
          return errorResult(toolCall, `Reschedule failed: ${message}`);
        }
      }

      // ====================================================
      // update_patient_name
      // ====================================================
      case 'update_patient_name': {
        const fullName = (args.full_name as string)?.trim();
        if (!fullName) {
          return errorResult(toolCall, 'full_name is required');
        }

        if (!patientId) {
          return errorResult(toolCall, 'No patient record found to update.');
        }

        // Update the dental_patients record — mark name as confirmed since
        // the patient explicitly provided it (not auto-pulled from WhatsApp).
        const { error: updateErr } = await db
          .from('dental_patients')
          .update({ full_name: fullName, name_confirmed: true, updated_at: new Date().toISOString() })
          .eq('id', patientId)
          .eq('account_id', accountId);

        if (updateErr) {
          console.error('[dental agent] update_patient_name error:', updateErr);
          return errorResult(toolCall, 'Failed to update patient name.');
        }

        // Also sync the linked WACRM contact name if one exists
        const { data: patient } = await db
          .from('dental_patients')
          .select('contact_id')
          .eq('id', patientId)
          .maybeSingle();

        if (patient?.contact_id) {
          await db
            .from('contacts')
            .update({ name: fullName })
            .eq('id', patient.contact_id);
        }

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              success: true,
              updated_name: fullName,
            }),
          },
        };
      }

      // ====================================================
      // transfer_to_human
      // ====================================================
      case 'transfer_to_human': {
        const reason = (args.reason as string) ?? 'Patient requested human assistance';

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              success: true,
              message: 'Conversation has been transferred to a human staff member.',
            }),
          },
          handoff: true,
          handoffReason: reason,
        };
      }

      // ====================================================
      // react_to_message
      // ====================================================
      case 'react_to_message': {
        const emoji = args.emoji as string;
        if (!emoji) {
          return errorResult(toolCall, 'emoji is required');
        }

        try {
          await ctx.waService.sendReaction({
            accountId,
            phone,
            targetMessageId: ctx.waMessageId,
            emoji,
          });
        } catch (err) {
          // A failed reaction send should never block or fail the turn —
          // reactions are a nice-to-have, not the point of the interaction.
          console.warn('[dental agent] react_to_message failed (non-blocking):', err);
        }

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ success: true, emoji }),
          },
        };
      }

      default:
        return errorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
  } catch (err) {
    console.error(`[dental agent] tool execution error (${toolCall.name}):`, err);
    return errorResult(
      toolCall,
      `Internal error executing ${toolCall.name}. Please try again or transfer to a human.`,
    );
  }
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function errorResult(
  toolCall: ToolCall,
  message: string,
): { result: ToolResult } {
  return {
    result: {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify({ error: message }),
    },
  };
}

/**
 * Verify that an appointment belongs to the given patient.
 * Server-side ownership check — never trust the model's stated appointment_id.
 */
async function verifyAppointmentOwnership(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
  patientId: string | null,
): Promise<boolean> {
  if (!patientId) return false;

  const { data, error } = await db
    .from('dental_appointments')
    .select('id')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .eq('patient_id', patientId)
    .maybeSingle();

  return !error && !!data;
}
