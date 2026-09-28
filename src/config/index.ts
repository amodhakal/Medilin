import "server-only";

import { getServerEnv } from "@/lib/env";

/**
 * Non-secret application configuration.
 *
 * Every value here previously lived as a hardcoded literal in a source file:
 * the two ElevenLabs agent ids sat in the client bundle, the clinic name and
 * the Resend sender were inline in route handlers. They now resolve from the
 * validated environment in src/lib/env.ts.
 *
 * `server-only` keeps this module out of the client graph, so a future
 * secret cannot be read into a browser bundle by accident.
 */

export function getClinicName(): string {
  return getServerEnv().CLINIC_NAME;
}

export function getEmailFrom(): string {
  return getServerEnv().EMAIL_FROM;
}

export function getPatientAgentId(): string {
  return getServerEnv().ELEVENLABS_AGENT_PATIENT_ID;
}

export function getReceptionistAgentId(): string {
  return getServerEnv().ELEVENLABS_AGENT_RECEPTIONIST_ID;
}
