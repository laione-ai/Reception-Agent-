// ============================================================
// Dental Clinic — Demo Data Seeder.
//
// Creates realistic dummy data for testing:
//   3 doctors, 20 patients, 30+ appointments
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadClinicConfig } from './config';
import { scheduleRemindersForAppointment } from './reminder-service';
import type { DentalAppointment } from './types';

const DOCTORS = [
  { full_name: 'Dr. Anna van der Berg', specialization: 'General Dentistry', email: 'anna@dental.demo' },
  { full_name: 'Dr. Pieter de Vries', specialization: 'Orthodontics', email: 'pieter@dental.demo' },
  { full_name: 'Dr. Sophie Jansen', specialization: 'Periodontics', email: 'sophie@dental.demo' },
];

const PATIENTS = [
  { full_name: 'Emma de Groot', phone: '+31612345001' },
  { full_name: 'Lucas Bakker', phone: '+31612345002' },
  { full_name: 'Julia Visser', phone: '+31612345003' },
  { full_name: 'Daan Smit', phone: '+31612345004' },
  { full_name: 'Sophie Mulder', phone: '+31612345005' },
  { full_name: 'Finn Bos', phone: '+31612345006' },
  { full_name: 'Mila Dekker', phone: '+31612345007' },
  { full_name: 'Noah Hendriks', phone: '+31612345008' },
  { full_name: 'Tess Vos', phone: '+31612345009' },
  { full_name: 'Liam Vermeer', phone: '+31612345010' },
  { full_name: 'Sara Peters', phone: '+31612345011' },
  { full_name: 'Max Kramer', phone: '+31612345012' },
  { full_name: 'Isa Meijer', phone: '+31612345013' },
  { full_name: 'Tom Scholten', phone: '+31612345014' },
  { full_name: 'Eva Willems', phone: '+31612345015' },
  { full_name: 'Sam de Boer', phone: '+31612345016' },
  { full_name: 'Lotte Brouwer', phone: '+31612345017' },
  { full_name: 'Jesse van Dijk', phone: '+31612345018' },
  { full_name: 'Anna Janssen', phone: '+31612345019' },
  { full_name: 'Bo van Leeuwen', phone: '+31612345020' },
];

const TREATMENTS = [
  'Regular Checkup',
  'Teeth Cleaning',
  'Filling',
  'Root Canal',
  'Crown Fitting',
  'Wisdom Tooth Extraction',
  'Orthodontic Consultation',
  'Teeth Whitening',
  'Dental X-Ray',
  'Gum Treatment',
];

export async function seedDentalData(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ doctors: number; patients: number; appointments: number }> {
  console.log('[dental:seed] Starting demo data seeding...');

  // Ensure clinic config exists
  const config = await loadClinicConfig(db, accountId, userId);

  // Create doctors (check-then-insert by account_id + full_name to
  // avoid duplicates on re-seed — the old onConflict: 'id' approach
  // could never match because no id was provided in the payload).
  const doctorIds: string[] = [];
  for (const doc of DOCTORS) {
    // Check if this doctor already exists for this account
    const { data: existing } = await db
      .from('dental_doctors')
      .select('id')
      .eq('account_id', accountId)
      .eq('full_name', doc.full_name)
      .maybeSingle();

    if (existing) {
      // Update the existing record to keep seed data fresh
      await db
        .from('dental_doctors')
        .update({ ...doc, user_id: userId, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('account_id', accountId);
      doctorIds.push(existing.id);
    } else {
      // Insert a new doctor
      const { data, error } = await db
        .from('dental_doctors')
        .insert({ account_id: accountId, user_id: userId, ...doc })
        .select('id')
        .single();

      if (error) {
        console.error('[dental:seed] doctor insert failed:', error);
      } else {
        doctorIds.push(data.id);
      }
    }
  }

  // Create patients
  const patientIds: string[] = [];
  for (const pat of PATIENTS) {
    const { data, error } = await db
      .from('dental_patients')
      .upsert(
        { account_id: accountId, user_id: userId, ...pat },
        { onConflict: 'account_id,phone' },
      )
      .select('id')
      .single();

    if (error) {
      const { data: existing } = await db
        .from('dental_patients')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone', pat.phone)
        .maybeSingle();

      if (existing) {
        patientIds.push(existing.id);
      } else {
        console.error('[dental:seed] patient insert failed:', error);
      }
    } else {
      patientIds.push(data.id);
    }
  }

  // Create appointments spread across the next 7 days
  let appointmentCount = 0;
  const now = new Date();

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const appointmentsPerDay = 4 + Math.floor(Math.random() * 3); // 4-6 per day

    for (let i = 0; i < appointmentsPerDay; i++) {
      const doctorId = doctorIds[Math.floor(Math.random() * doctorIds.length)];
      const patientId = patientIds[Math.floor(Math.random() * patientIds.length)];
      const treatment = TREATMENTS[Math.floor(Math.random() * TREATMENTS.length)];
      const hour = 9 + Math.floor(Math.random() * 7); // 9 AM - 3 PM
      const minute = Math.random() > 0.5 ? 0 : 30;
      const duration = Math.random() > 0.7 ? 60 : 30;

      const startsAt = new Date(now);
      startsAt.setDate(startsAt.getDate() + dayOffset + 1);
      startsAt.setHours(hour, minute, 0, 0);

      const endsAt = new Date(startsAt.getTime() + duration * 60_000);

      // Random status for variety
      const statuses: Array<'scheduled' | 'confirmed' | 'cancelled'> = [
        'scheduled', 'scheduled', 'scheduled', 'confirmed', 'cancelled',
      ];
      const status = dayOffset === 0 ? 'scheduled' : statuses[Math.floor(Math.random() * statuses.length)];

      try {
        const { data: appt, error } = await db
          .from('dental_appointments')
          .insert({
            account_id: accountId,
            user_id: userId,
            patient_id: patientId,
            doctor_id: doctorId,
            starts_at: startsAt.toISOString(),
            ends_at: endsAt.toISOString(),
            duration_minutes: duration,
            status,
            treatment_type: treatment,
            confirmed_at: status === 'confirmed' ? now.toISOString() : null,
            cancelled_at: status === 'cancelled' ? now.toISOString() : null,
          })
          .select()
          .single();

        if (!error && appt) {
          appointmentCount++;

          // Schedule reminders for 'scheduled' appointments
          if (status === 'scheduled') {
            await scheduleRemindersForAppointment(db, appt as DentalAppointment, config);
          }
        }
      } catch {
        // Skip conflicts (double-booking exclusion constraint)
      }
    }
  }

  // Also create a few past appointments (completed / no_show)
  for (let i = 0; i < 5; i++) {
    const doctorId = doctorIds[Math.floor(Math.random() * doctorIds.length)];
    const patientId = patientIds[Math.floor(Math.random() * patientIds.length)];

    const startsAt = new Date(now);
    startsAt.setDate(startsAt.getDate() - (i + 1));
    startsAt.setHours(10 + i, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

    try {
      await db.from('dental_appointments').insert({
        account_id: accountId,
        user_id: userId,
        patient_id: patientId,
        doctor_id: doctorId,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        duration_minutes: 30,
        status: i % 2 === 0 ? 'completed' : 'no_show',
        treatment_type: TREATMENTS[i],
        completed_at: i % 2 === 0 ? endsAt.toISOString() : null,
      });
      appointmentCount++;
    } catch {
      // Skip conflicts
    }
  }

  console.log(`[dental:seed] Done: ${doctorIds.length} doctors, ${patientIds.length} patients, ${appointmentCount} appointments`);

  return {
    doctors: doctorIds.length,
    patients: patientIds.length,
    appointments: appointmentCount,
  };
}
