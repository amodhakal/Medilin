import { getPatientAgentId, getReceptionistAgentId } from "@/config";
import { resolveRecord } from "@/lib/phi-token";
import { notFound } from "next/navigation";
import SpectateClient, { type SpectatePatient } from "./SpectateClient";

/**
 * Server wrapper for the spectate session.
 *
 * The agent identifiers are configuration and must not be hardcoded, so they
 * are read here rather than in the client bundle where they previously sat as
 * literals anyone could read off the shipped JavaScript.
 *
 * The route segment is a token, not a record. The page used to read the record
 * out of a `?patientInfo=` query parameter in the browser, which meant the
 * plaintext record was in the URL, in browser history, in the Referer header of
 * anything the page loaded, and in every access log between the browser and
 * this server. Resolving it here keeps it out of all of those.
 *
 * `resolveRecord` is awaited because a token can now be a short reference to a
 * stored record rather than the record sealed into the URL, and reading one back
 * is a query. The sealed format still resolves here, so a link that was already
 * sent to someone keeps working.
 *
 * It also retires three bugs that came with reading the URL in the client:
 * a double decodeURIComponent that threw a URIError on a stray `%`, a
 * JSON.parse whose failure left the Start button permanently disabled with
 * only a console message, and no validation of the id at all, so any crafted
 * URL rendered with whatever data it carried.
 */
export default async function SpectatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const plaintext = await resolveRecord(id);
  if (!plaintext) {
    // Not a valid link: truncated, tampered, sealed under a different key, or
    // from an older version. The four cases are deliberately not
    // distinguished, since that tells an attacker which one they achieved.
    notFound();
  }

  let record: unknown;
  try {
    record = JSON.parse(plaintext);
  } catch {
    notFound();
  }

  const patient = toSpectatePatient(record);
  if (!patient) notFound();

  return (
    <SpectateClient
      patient={patient}
      patientAgentId={getPatientAgentId()}
      receptionistAgentId={getReceptionistAgentId()}
    />
  );
}

/**
 * Narrow the decrypted record to what this page actually renders and sends.
 *
 * An explicit allowlist rather than a cast. The token decrypts to whatever was
 * sealed, and a cast would let a record with a missing or wrong-typed field
 * through to fail somewhere in the render instead of here.
 */
function toSpectatePatient(record: unknown): SpectatePatient | null {
  if (typeof record !== "object" || record === null) return null;

  const source = record as Record<string, unknown>;

  const text = (key: string, max = 200): string =>
    typeof source[key] === "string" ? (source[key] as string).slice(0, max) : "";

  const firstName = text("firstName", 100);
  const lastName = text("lastName", 100);
  const email = text("email", 254);

  if (!firstName || !lastName || !email) return null;

  return {
    firstName,
    lastName,
    email,
    dob: text("dob", 10),
    phone: text("phone", 40),
    language: text("language", 32),
    medical_department: text("medical_department", 100),
    additionalInfo: text("additionalInfo", 2000),
    insurance: text("insurance", 8),
    appointmentDateTime: text("appointmentDateTime", 40),
  };
}
