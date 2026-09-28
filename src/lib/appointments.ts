import { v4 as uuidv4 } from "uuid";

export interface Appointment {
  id: string;
  patientInfo: Record<string, unknown>;
  createdAt: Date;
  conversationEnded: boolean;
}

const appointments = new Map<string, Appointment>();

export function createAppointment(patientInfo: Record<string, unknown>): Appointment {
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
