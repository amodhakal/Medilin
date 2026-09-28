import { getPatientAgentId, getReceptionistAgentId } from "@/config";
import SpectateClient from "./SpectateClient";

/**
 * Server wrapper for the spectate session.
 *
 * The session UI is a client component, but the agent identifiers are
 * configuration and must not be hardcoded. Reading them here keeps the
 * source of truth in the environment (src/lib/env.ts) instead of the client
 * bundle, where they previously sat as literals anyone could read off the
 * shipped JavaScript.
 */
export default async function SpectatePage({
  searchParams,
}: {
  searchParams: Promise<{ patientInfo?: string }>;
}) {
  return (
    <SpectateClient
      searchParams={searchParams}
      patientAgentId={getPatientAgentId()}
      receptionistAgentId={getReceptionistAgentId()}
    />
  );
}
