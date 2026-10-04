// ============================================================
// Dental Clinic — WhatsApp Service.
//
// Abstraction layer with two implementations:
//   1. RealWhatsAppService — uses existing WACRM send pipeline
//   2. MockWhatsAppService — logs to DB for demo mode
//
// Both produce the same interactive button messages:
//   [Confirm ✅] [Cancel ❌] [Reschedule 📅]
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DentalAppointment,
  DentalAppointmentReminder,
  DentalClinicConfig,
} from './types';
import { DENTAL_BUTTON_IDS } from './types';
import { formatInClinicTimezone } from './config';

// -------------------------------------------------------
// Service interface
// -------------------------------------------------------

export interface SendResult {
  messageId: string | null;
  messageText: string;
}

export interface DentalWhatsAppService {
  sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    body: string;
    header?: string;
    footer?: string;
    buttons: Array<{ id: string; title: string }>;
  }): Promise<SendResult>;

  sendTextMessage(params: {
    accountId: string;
    phone: string;
    text: string;
  }): Promise<SendResult>;

  sendInteractiveList(params: {
    accountId: string;
    phone: string;
    body: string;
    buttonLabel: string;
    header?: string;
    footer?: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  }): Promise<SendResult>;

  sendReaction(params: {
    accountId: string;
    phone: string;
    /** Meta message_id of the message to react to. */
    targetMessageId: string;
    /** Single emoji (e.g. "👍"). */
    emoji: string;
  }): Promise<SendResult>;
}

// -------------------------------------------------------
// Mock implementation (demo mode)
// -------------------------------------------------------

export class MockWhatsAppService implements DentalWhatsAppService {
  private db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    body: string;
    header?: string;
    footer?: string;
    buttons: Array<{ id: string; title: string }>;
  }): Promise<SendResult> {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log('[dental:mock] 📱 WhatsApp Interactive Message:');
    console.log(`  To: ${params.phone}`);
    if (params.header) console.log(`  Header: ${params.header}`);
    console.log(`  Body: ${params.body}`);
    if (params.footer) console.log(`  Footer: ${params.footer}`);
    console.log(`  Buttons: ${params.buttons.map((b) => `[${b.title}]`).join(' ')}`);

    await this.db.from('dental_message_log').insert({
      account_id: params.accountId,
      direction: 'outbound',
      message_type: 'interactive',
      content: params.body,
      interactive_payload: {
        header: params.header,
        footer: params.footer,
        buttons: params.buttons,
      },
      whatsapp_message_id: mockId,
      mock_mode: true,
    });

    return { messageId: mockId, messageText: params.body };
  }

  async sendTextMessage(params: {
    accountId: string;
    phone: string;
    text: string;
  }): Promise<SendResult> {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log('[dental:mock] 📱 WhatsApp Text Message:');
    console.log(`  To: ${params.phone}`);
    console.log(`  Text: ${params.text}`);

    await this.db.from('dental_message_log').insert({
      account_id: params.accountId,
      direction: 'outbound',
      message_type: 'text',
      content: params.text,
      whatsapp_message_id: mockId,
      mock_mode: true,
    });

    return { messageId: mockId, messageText: params.text };
  }

  async sendInteractiveList(params: {
    accountId: string;
    phone: string;
    body: string;
    buttonLabel: string;
    header?: string;
    footer?: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  }): Promise<SendResult> {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log('[dental:mock] 📱 WhatsApp List Message:');
    console.log(`  To: ${params.phone}`);
    if (params.header) console.log(`  Header: ${params.header}`);
    console.log(`  Body: ${params.body}`);
    console.log(`  Button: [${params.buttonLabel}]`);
    for (const section of params.sections) {
      if (section.title) console.log(`  Section: ${section.title}`);
      for (const row of section.rows) {
        console.log(`    - ${row.title}${row.description ? ` (${row.description})` : ''}`);
      }
    }

    await this.db.from('dental_message_log').insert({
      account_id: params.accountId,
      direction: 'outbound',
      message_type: 'interactive',
      content: params.body,
      interactive_payload: {
        kind: 'list',
        header: params.header,
        footer: params.footer,
        button_label: params.buttonLabel,
        sections: params.sections,
      },
      whatsapp_message_id: mockId,
      mock_mode: true,
    });

    return { messageId: mockId, messageText: params.body };
  }

  async sendReaction(params: {
    accountId: string;
    phone: string;
    targetMessageId: string;
    emoji: string;
  }): Promise<SendResult> {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log('[dental:mock] 📱 WhatsApp Reaction:');
    console.log(`  To: ${params.phone}`);
    console.log(`  Target: ${params.targetMessageId}`);
    console.log(`  Emoji: ${params.emoji}`);

    await this.db.from('dental_message_log').insert({
      account_id: params.accountId,
      direction: 'outbound',
      message_type: 'text',
      content: `[Reaction ${params.emoji} on ${params.targetMessageId}]`,
      whatsapp_message_id: mockId,
      mock_mode: true,
    });

    return { messageId: mockId, messageText: params.emoji };
  }
}

// -------------------------------------------------------
// Real implementation (uses WACRM WhatsApp pipeline)
// -------------------------------------------------------

export class RealWhatsAppService implements DentalWhatsAppService {
  private db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    body: string;
    header?: string;
    footer?: string;
    buttons: Array<{ id: string; title: string }>;
  }): Promise<SendResult> {
    // Dynamically import to avoid circular deps
    const { resolveConversationByPhone } = await import(
      '@/lib/whatsapp/resolve-conversation'
    );
    const { sendInteractiveButtons } = await import('@/lib/whatsapp/meta-api');
    const { decrypt } = await import('@/lib/whatsapp/encryption');

    // Get WhatsApp config for this account
    const { data: config } = await this.db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', params.accountId)
      .limit(1)
      .single();

    if (!config) {
      throw new Error('WhatsApp not configured for this account');
    }

    const accessToken = decrypt(config.access_token);

    // Resolve or create conversation
    const resolved = await resolveConversationByPhone(
      this.db,
      params.accountId,
      params.phone,
    );

    // Send via Meta API
    const result = await sendInteractiveButtons({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: params.phone,
      bodyText: params.body,
      headerText: params.header,
      footerText: params.footer,
      buttons: params.buttons,
    });

    // Persist to messages table
    const { error: msgErr } = await this.db.from('messages').insert({
      conversation_id: resolved.conversationId,
      content_type: 'interactive',
      content_text: params.body,
      sender_type: 'bot',
      message_id: result.messageId,
      status: 'sent',
      interactive_payload: {
        kind: 'buttons',
        body: params.body,
        header: params.header,
        footer: params.footer,
        buttons: params.buttons,
      },
    });
    if (msgErr) {
      console.error('[dental] failed to persist outbound message to inbox:', msgErr);
    }

    // Update conversation
    await this.db
      .from('conversations')
      .update({
        last_message_text: params.body,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', resolved.conversationId);

    return { messageId: result.messageId, messageText: params.body };
  }

  async sendTextMessage(params: {
    accountId: string;
    phone: string;
    text: string;
  }): Promise<SendResult> {
    const { resolveConversationByPhone } = await import(
      '@/lib/whatsapp/resolve-conversation'
    );
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    const { decrypt } = await import('@/lib/whatsapp/encryption');

    const { data: config } = await this.db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', params.accountId)
      .limit(1)
      .single();

    if (!config) {
      throw new Error('WhatsApp not configured for this account');
    }

    const accessToken = decrypt(config.access_token);

    const resolved = await resolveConversationByPhone(
      this.db,
      params.accountId,
      params.phone,
    );

    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: params.phone,
      text: params.text,
    });

    const { error: msgErr } = await this.db.from('messages').insert({
      conversation_id: resolved.conversationId,
      content_type: 'text',
      content_text: params.text,
      sender_type: 'bot',
      message_id: result.messageId,
      status: 'sent',
    });
    if (msgErr) {
      console.error('[dental] failed to persist outbound message to inbox:', msgErr);
    }

    await this.db
      .from('conversations')
      .update({
        last_message_text: params.text,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', resolved.conversationId);

    return { messageId: result.messageId, messageText: params.text };
  }

  async sendInteractiveList(params: {
    accountId: string;
    phone: string;
    body: string;
    buttonLabel: string;
    header?: string;
    footer?: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  }): Promise<SendResult> {
    const { resolveConversationByPhone } = await import(
      '@/lib/whatsapp/resolve-conversation'
    );
    const { sendInteractiveList } = await import('@/lib/whatsapp/meta-api');
    const { decrypt } = await import('@/lib/whatsapp/encryption');

    const { data: config } = await this.db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', params.accountId)
      .limit(1)
      .single();

    if (!config) {
      throw new Error('WhatsApp not configured for this account');
    }

    const accessToken = decrypt(config.access_token);

    const resolved = await resolveConversationByPhone(
      this.db,
      params.accountId,
      params.phone,
    );

    const result = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: params.phone,
      bodyText: params.body,
      buttonLabel: params.buttonLabel,
      headerText: params.header,
      footerText: params.footer,
      sections: params.sections,
    });

    const { error: msgErr } = await this.db.from('messages').insert({
      conversation_id: resolved.conversationId,
      content_type: 'interactive',
      content_text: params.body,
      sender_type: 'bot',
      message_id: result.messageId,
      status: 'sent',
      interactive_payload: {
        kind: 'list',
        body: params.body,
        header: params.header,
        footer: params.footer,
        button_label: params.buttonLabel,
        sections: params.sections,
      },
    });
    if (msgErr) {
      console.error('[dental] failed to persist outbound message to inbox:', msgErr);
    }

    await this.db
      .from('conversations')
      .update({
        last_message_text: params.body,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', resolved.conversationId);

    return { messageId: result.messageId, messageText: params.body };
  }

  async sendReaction(params: {
    accountId: string;
    phone: string;
    targetMessageId: string;
    emoji: string;
  }): Promise<SendResult> {
    const { sendReactionMessage } = await import('@/lib/whatsapp/meta-api');
    const { decrypt } = await import('@/lib/whatsapp/encryption');

    const { data: config } = await this.db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', params.accountId)
      .limit(1)
      .single();

    if (!config) {
      throw new Error('WhatsApp not configured for this account');
    }

    const accessToken = decrypt(config.access_token);

    const result = await sendReactionMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: params.phone,
      targetMessageId: params.targetMessageId,
      emoji: params.emoji,
    });

    return { messageId: result.messageId, messageText: params.emoji };
  }
}

// -------------------------------------------------------
// Factory
// -------------------------------------------------------

export function createWhatsAppService(
  db: SupabaseClient,
  demoMode: boolean,
): DentalWhatsAppService {
  return demoMode ? new MockWhatsAppService(db) : new RealWhatsAppService(db);
}

// -------------------------------------------------------
// Reminder message builder
// -------------------------------------------------------

export async function sendAppointmentReminder(
  db: SupabaseClient,
  waService: DentalWhatsAppService,
  appointment: DentalAppointment,
  reminder: DentalAppointmentReminder,
  config: DentalClinicConfig,
): Promise<SendResult> {
  const patient = appointment.patient;
  const doctor = appointment.doctor;

  if (!patient || !doctor) {
    throw new Error('Appointment missing patient or doctor data');
  }

  const tz = config.clinic_timezone;
  const dateStr = formatInClinicTimezone(appointment.starts_at, tz, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = formatInClinicTimezone(appointment.starts_at, tz, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const patientName = patient.full_name.split(' ')[0]; // First name
  const doctorName = doctor.full_name;
  const treatment = appointment.treatment_type
    ? ` for ${appointment.treatment_type}`
    : '';

  let body: string;
  let header: string | undefined;

  switch (reminder.reminder_type) {
    case 'initial_12h':
      header = `🦷 Appointment Reminder`;
      body =
        `Hi ${patientName}! This is a reminder about your upcoming appointment` +
        `${treatment} with Dr. ${doctorName}.\n\n` +
        `📅 ${dateStr}\n` +
        `🕐 ${timeStr}\n` +
        `📍 ${config.clinic_name}\n\n` +
        `Please confirm, cancel, or reschedule your appointment.`;
      break;

    case 'follow_up':
      header = `🦷 Reminder: Please respond`;
      body =
        `Hi ${patientName}, we haven't heard from you yet about your appointment` +
        `${treatment} with Dr. ${doctorName}.\n\n` +
        `📅 ${dateStr} at ${timeStr}\n\n` +
        `Please let us know if you can make it.`;
      break;

    case 'final_2h':
      header = `🦷 Final Reminder — 2 Hours`;
      body =
        `Hi ${patientName}, your appointment with Dr. ${doctorName} is in 2 hours!\n\n` +
        `📅 Today at ${timeStr}\n` +
        `📍 ${config.clinic_name}\n\n` +
        `Please confirm or let us know if you need to cancel.`;
      break;
  }

  return waService.sendInteractiveButtons({
    accountId: appointment.account_id,
    phone: patient.phone,
    body,
    header,
    footer: config.clinic_name,
    buttons: [
      { id: DENTAL_BUTTON_IDS.CONFIRM, title: 'Confirm ✅' },
      { id: DENTAL_BUTTON_IDS.CANCEL, title: 'Cancel ❌' },
      { id: DENTAL_BUTTON_IDS.RESCHEDULE, title: 'Reschedule 📅' },
    ],
  });
}
