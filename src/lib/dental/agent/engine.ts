// ============================================================
// Dental Agent — Core engine.
//
// The main tool-calling loop that:
//   1. Loads/creates a session
//   2. Builds the LLM context (system prompt + conversation history)
//   3. Calls the LLM with tools
//   4. Executes tool calls server-side
//   5. Feeds results back to the LLM
//   6. Repeats until the model responds with text (done)
//   7. Composes and sends the reply
//
// Key invariants:
//   - The LLM never writes to the database directly
//   - Booking/cancel/reschedule confirmations are composed by
//     deterministic code from actual DB rows, not by the model
//   - Max 6 tool-calling round trips per inbound message
//   - Timeout/error → graceful human handoff
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DentalAppointment, DentalClinicConfig } from '../types';
import type {
  AgentContext,
  AgentTurnResult,
  ToolCallingMessage,
} from './types';
import { loadAiConfig } from '@/lib/ai/config';
import { aiRequestTimeoutMs } from '@/lib/ai/defaults';
import { generateWithTools } from './providers';
import { DENTAL_TOOLS, executeTool, type ToolExecutionContext } from './tools';
import { buildDentalAgentPrompt } from './prompt';
import {
  loadActiveSession,
  createSession,
  updateSession,
  completeSession,
  isSessionExpired,
  isMessageAlreadyProcessed,
} from './session';
import { loadClinicConfig, formatInClinicTimezone } from '../config';
import { formatCalendarLinksForWhatsApp } from '../calendar';

/** Maximum tool-calling round trips per inbound message. */
const MAX_ROUNDS = 6;

/**
 * Run one agent turn for an inbound message.
 *
 * This is the heart of the AI receptionist. It manages the session,
 * calls the LLM, executes tools, and sends the reply.
 */
export async function runAgentTurn(
  db: SupabaseClient,
  ctx: AgentContext,
  inboundText: string,
  waMessageId: string,
): Promise<AgentTurnResult> {
  const { accountId, conversationId, contactId, phone, configOwnerUserId } = ctx;

  // -------------------------------------------------------
  // 1. Load AI config (BYOK credentials)
  // -------------------------------------------------------
  const aiConfig = await loadAiConfig(db, accountId);
  if (!aiConfig) {
    console.warn('[dental agent] No AI config for account', accountId);
    return { consumed: false };
  }

  // -------------------------------------------------------
  // 2. Load clinic config + doctors + patient
  // -------------------------------------------------------
  const config = await loadClinicConfig(db, accountId, configOwnerUserId);
  const { data: doctors } = await db
    .from('dental_doctors')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('full_name');

  // Resolve patient from phone — auto-register if this is a new caller
  // Track whether the patient was just auto-registered in this call —
  // their name came from WhatsApp profile and has NOT been confirmed.
  let isNewlyAutoRegistered = false;

  const patient = await (async () => {
    const { data: existing } = await db
      .from('dental_patients')
      .select('id, full_name, name_confirmed')
      .eq('account_id', accountId)
      .eq('phone', phone)
      .maybeSingle();

    if (existing) return existing;

    // New caller — auto-create patient from the WACRM contact record
    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', contactId)
      .maybeSingle();

    const patientName = contact?.name?.trim() || phone;

    const { data: created, error: createErr } = await db
      .from('dental_patients')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        contact_id: contactId,
        full_name: patientName,
        phone,
      })
      .select('id, full_name')
      .single();

    if (createErr) {
      console.error('[dental agent] failed to auto-register patient:', createErr);
      return null;
    }

    isNewlyAutoRegistered = true;
    console.log('[dental agent] auto-registered new patient:', created.id, patientName);
    return created;
  })();

  const patientId = patient?.id ?? null;
  const patientName = patient?.full_name ?? undefined;

  // Detect if the patient's name is just a phone number placeholder.
  // This happens when a new patient is auto-registered from a WACRM contact
  // that has no name set — the phone number is used as a fallback.
  const nameIsPlaceholder = patientName
    ? /^\+?[\d\s\-()]+$/.test(patientName.trim())
    : false;

  // Detect if the patient's name is unconfirmed — auto-pulled from
  // WhatsApp profile (could be a nickname, joke name, family member's
  // name, etc.). Treat as unconfirmed when:
  //   1. The patient was just auto-registered in this call, OR
  //   2. The patient record has never had their name explicitly confirmed
  //      (name_confirmed column, if it exists, or no prior appointments)
  // In either case, the prompt will ask the patient to confirm their name.
  // NOTE: nameIsPlaceholder takes priority (bare phone number → different prompt).
  const nameIsUnconfirmed = !nameIsPlaceholder && patientName && (
    isNewlyAutoRegistered ||
    (patient && 'name_confirmed' in patient && !(patient as Record<string, unknown>).name_confirmed)
  );

  // Load patient's upcoming appointments
  let patientAppointments: DentalAppointment[] = [];
  if (patientId) {
    const { data: appts } = await db
      .from('dental_appointments')
      .select('*, patient:dental_patients(*), doctor:dental_doctors(*)')
      .eq('account_id', accountId)
      .eq('patient_id', patientId)
      .in('status', ['scheduled', 'reminder_sent', 'confirmed'])
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(5);
    patientAppointments = (appts ?? []) as DentalAppointment[];
  }

  // -------------------------------------------------------
  // 3. Load or create session
  // -------------------------------------------------------
  let session = await loadActiveSession(db, accountId, phone);

  if (session && isSessionExpired(session)) {
    await completeSession(db, session.id, 'expired');
    session = null;
  }

  // Idempotency: if this exact message was already processed, skip
  if (session && isMessageAlreadyProcessed(session, waMessageId)) {
    console.log('[dental agent] duplicate message detected, skipping:', waMessageId);
    return { consumed: true };
  }

  if (!session) {
    session = await createSession(db, accountId, phone, conversationId, patientId);
  }

  // Update patient_id if we just resolved it
  if (patientId && !session.patient_id) {
    await updateSession(db, session.id, { patient_id: patientId });
    session.patient_id = patientId;
  }

  // -------------------------------------------------------
  // 4. Build LLM messages
  // -------------------------------------------------------
  const systemPrompt = buildDentalAgentPrompt({
    config,
    patientAppointments,
    doctors: doctors ?? [],
    patientName,
    nameIsPlaceholder,
    nameIsUnconfirmed: !!nameIsUnconfirmed,
  });

  // Start with the system message
  const llmMessages: ToolCallingMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history from session
  for (const msg of session.messages) {
    llmMessages.push({ role: msg.role, content: msg.content });
  }

  // Add the new inbound message
  llmMessages.push({ role: 'user', content: inboundText });

  // Update session with the new user message
  const updatedMessages = [
    ...session.messages,
    { role: 'user' as const, content: inboundText },
  ];

  // -------------------------------------------------------
  // 5. Tool-calling loop
  // -------------------------------------------------------
  const timeoutMs = aiRequestTimeoutMs();
  let rounds = 0;
  let finalText = '';
  let handedOff = false;
  let handoffReason: string | undefined;
  let lastMutationAppointment: DentalAppointment | undefined;

  const toolCtx: ToolExecutionContext = {
    db,
    accountId,
    userId: configOwnerUserId,
    phone,
    patientId,
    config,
    conversationId,
  };

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;

      const result = await generateWithTools(aiConfig.provider, {
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        messages: llmMessages,
        tools: DENTAL_TOOLS,
        timeoutMs,
      });

      if (process.env.DENTAL_AGENT_DEBUG === 'true') {
        console.log(`[dental agent][debug] round ${rounds} — conversation ${conversationId}`);
        console.log('[dental agent][debug] context sent:', JSON.stringify(llmMessages, null, 2));
        console.log('[dental agent][debug] model text:', result.text);
        console.log('[dental agent][debug] tool calls:', JSON.stringify(result.toolCalls, null, 2));
      }

      if (result.done || result.toolCalls.length === 0) {
        // Model is done — it responded with text
        finalText = result.text;
        break;
      }

      // Model wants to call tools — add assistant message with tool calls
      llmMessages.push({
        role: 'assistant',
        content: result.text || undefined,
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of result.toolCalls) {
        const { result: toolResult, handoff, handoffReason: reason, appointment } = await executeTool(
          toolCall,
          toolCtx,
        );

        if (handoff) {
          handedOff = true;
          handoffReason = reason;
        }

        if (appointment) {
          lastMutationAppointment = appointment;
        }

        // Feed tool result back to the LLM
        llmMessages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_call_id,
          name: toolResult.name,
          content: toolResult.content,
        });
      }

      // If handoff was requested, stop the loop
      if (handedOff) {
        finalText = result.text || '';
        break;
      }
    }

    if (rounds >= MAX_ROUNDS && !finalText) {
      // Hit the round trip cap — force handoff
      handedOff = true;
      finalText = "I'm having trouble completing your request. Let me connect you with a staff member who can help.";
    }
  } catch (err) {
    // LLM timeout or error → graceful handoff
    console.error('[dental agent] LLM error:', err);
    handedOff = true;
    finalText = "I'm sorry, I'm having technical difficulties right now. Let me connect you with a staff member who can help you directly.";
  }

  // -------------------------------------------------------
  // 6. Handle handoff
  // -------------------------------------------------------
  if (handedOff) {
    await performHandoff(db, conversationId, accountId, aiConfig.handoffAgentId, session.messages, session.turn_count, handoffReason);
    await completeSession(db, session.id, 'handed_off');
  }

  // -------------------------------------------------------
  // 7. Compose the reply
  // -------------------------------------------------------
  // If a booking/cancel/reschedule just succeeded, append a deterministic
  // confirmation composed from the actual DB row — NOT model text.
  let replyText = finalText;

  if (lastMutationAppointment && !handedOff) {
    const deterministicConfirmation = composeDeterministicConfirmation(
      lastMutationAppointment,
      config,
    );
    if (deterministicConfirmation) {
      // Use the deterministic confirmation, optionally preceded by the model's conversational text
      replyText = finalText
        ? `${finalText}\n\n${deterministicConfirmation}`
        : deterministicConfirmation;
    }
  }

  // -------------------------------------------------------
  // 8. Update session
  // -------------------------------------------------------
  const assistantMessages = [
    ...updatedMessages,
    { role: 'assistant' as const, content: replyText },
  ];

  if (!handedOff) {
    await updateSession(db, session.id, {
      messages: assistantMessages,
      turn_count: session.turn_count + 1,
      last_message_id: waMessageId,
      state: lastMutationAppointment ? 'completed' : session.state === 'awaiting_intent' ? 'collecting_info' : session.state,
    });

    // If we completed a mutation, mark session complete
    if (lastMutationAppointment) {
      await completeSession(db, session.id, 'completed');
    }
  }

  return {
    consumed: true,
    reply: replyText,
    handedOff,
  };
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/**
 * Compose a deterministic confirmation message from an actual DB row.
 * This ensures booking/cancel/reschedule confirmations are factual,
 * not model-generated (R10).
 */
function composeDeterministicConfirmation(
  appointment: DentalAppointment,
  config: DentalClinicConfig,
): string | null {
  const tz = config.clinic_timezone;
  const dateStr = formatInClinicTimezone(appointment.starts_at, tz, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = formatInClinicTimezone(appointment.starts_at, tz, {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const doctorName = appointment.doctor?.full_name ?? 'your provider';

  switch (appointment.status) {
    case 'scheduled':
    case 'confirmed': {
      const calendarLinks = formatCalendarLinksForWhatsApp(appointment, config);
      return (
        `✅ Appointment confirmed!\n\n` +
        `📅 ${dateStr}\n` +
        `🕐 ${timeStr}\n` +
        `👨‍⚕️ Dr. ${doctorName}\n` +
        `📍 ${config.clinic_name}` +
        (appointment.treatment_type ? `\n🦷 ${appointment.treatment_type}` : '') +
        `\n\n${calendarLinks}`
      );
    }

    case 'cancelled':
      return (
        `❌ Your appointment on ${dateStr} at ${timeStr} with Dr. ${doctorName} has been cancelled.`
      );

    default:
      return null;
  }
}

/**
 * Perform the handoff — mirrors the existing pattern from ai/auto-reply.ts.
 */
async function performHandoff(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
  handoffAgentId: string | null,
  messages: Array<{ role: string; content: string }>,
  replyCount: number,
  reason?: string,
): Promise<void> {
  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim());

  const replies = replyCount === 0
    ? 'without replying'
    : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  let summary = `🦷 Dental AI receptionist handed off ${replies}.`;
  if (reason) {
    summary += ` Reason: ${reason}`;
  }
  if (lastCustomer) {
    const quote = lastCustomer.content.trim().length > 160
      ? lastCustomer.content.trim().slice(0, 159) + '…'
      : lastCustomer.content.trim();
    summary += ` Last patient message: "${quote}"`;
  }

  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  };

  // Only set assignee if configured and not already assigned
  if (handoffAgentId) {
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (conv && !conv.assigned_agent_id) {
      update.assigned_agent_id = handoffAgentId;
    }
  }

  await db.from('conversations').update(update).eq('id', conversationId);
}
