import { v4 as uuidv4 } from "uuid";
import type { AppointmentRecord } from "@/lib/validation/intake";

export interface Appointment {
  id: string;
  /**
   * The patient record.
   *
   * Previously typed `Record<string, unknown>`, which meant no field access
   * anywhere downstream was checked and `patientInfo.firstName` was `unknown`
   * even though the intake form guarantees it. The shape now comes from the
   * validation schema, so the store and the form cannot drift apart.
   */
  patientInfo: AppointmentRecord;
  createdAt: Date;
  conversationEnded: boolean;
}

const appointments = new Map<string, Appointment>();

export function createAppointment(patientInfo: AppointmentRecord): Appointment {
  const id = uuidv4();
  const appointment: Appointment = {
    id,
    patientInfo,
    createdAt: new Date(),
    conversationEnded: false,
  };
  appointments.set(id, appointment);
  return appointment;
}

export function getAppointment(id: string): Appointment | undefined {
  return appointments.get(id);
}
