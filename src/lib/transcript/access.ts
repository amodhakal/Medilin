import "server-only";

import { getAppointment, readTranscript, type Appointment, type TranscriptLine } from "@/lib/appointments";
import { AUDIT_ACTORS, recordAuditEvent, transcriptResource } from "@/lib/audit";
import { logInfo } from "@/lib/logger";
import { renderPdf } from "@/lib/pdf";
import { appointmentIdForToken } from "@/lib/phi-token";

/**
 * Who may read a call transcript, and what comes back when they may.
 *
 * One module, and the reason it is one module is that the replay page and the
 * PDF export have to make the *same* decision. Two surfaces that each resolve a
 * token and read a transcript will drift: one of them will grow a second check,
 * or a special case for a cancelled appointment, or a nicer error, and the other
 * will keep the original. A transcript is the patient's own account of why they
 * telephoned, so the difference between the two is the difference between a
 * control and an assumption.
 *
 * **The authorisation is the token that was already in the URL.** Not a session,
 * not an account, not a new bearer credential minted for this feature: the same
 * sealed-record or short-reference token the tracking page and the spectate page
 * are opened with. That is deliberate, and it is a limitation worth naming
 * rather than a design being proud of. A new access path would have been a second
 * way in to the most sensitive data in the application, and a feature that
 * needed one would be a feature nobody had asked for.
 *
 * **A token that names no appointment is refused.** A version 1 token is the
 * record sealed into the URL with nothing behind it, so there is no id to address
 * a transcript with. That is not a gap to be papered over with a guess.
 *
 * **Refusals are one answer.** A truncated token, a tampered one, one sealed
 * under another key, and one for an appointment that has been deleted are all
 * "no", because telling a prober which of the four they managed is a free
 * oracle. Nothing is logged about them either: the token is a credential, and a
 * credential in an aggregator's index is a credential somebody else can use.
 *
 * **The trail is written before the bytes are produced.** `buildTranscriptPdf`
 * records `TRANSCRIPT_EXPORTED` and throws if it cannot, so a PDF that left this
 * process is a PDF whose export is in the trail. A read that cannot be recorded
 * does not return the lines; an export that cannot be recorded does not render.
 */

/** A transcript, and the record it belongs to. */
export interface TranscriptSession {
  appointmentId: string;
  appointment: Appointment;
  lines: TranscriptLine[];
}

export interface TranscriptPdf {
  bytes: Uint8Array;
  filename: string;
  /** How many lines went in. Never printed into the file; this is for the response headers. */
  lineCount: number;
}

export interface OpenTranscriptOptions {
  now?: number;
  limit?: number;
}

/**
 * Open a transcript with a link, or answer no.
 *
 * The appointment is read as well as the lines, and both are for the header of
 * whatever the caller is about to render. A transcript with no record behind it
 * has nothing to say about when the call happened or what state the booking is
 * in, and both of those are things a reader of a medical transcript needs.
 */
export async function openTranscript(
  token: string,
  options: OpenTranscriptOptions = {},
): Promise<TranscriptSession | null> {
  const appointmentId = appointmentIdForToken(token);
  if (appointmentId === null) return null;

  // `getAppointment` audits the read and throws if the trail cannot be written,
  // so a session that comes back has already been recorded.
  const appointment = await getAppointment(appointmentId, AUDIT_ACTORS.linkBearer);
  if (!appointment) return null;

  // A cancelled appointment still has its transcript, exactly as a cancelled
  // appointment still has a tracking page. A patient whose call was cut short
  // should be able to see that it was, and the withdrawal in `cancelAppointment`
  // is about capabilities, not about records.
  const lines = await readTranscript(appointmentId, AUDIT_ACTORS.linkBearer, {
    limit: options.limit,
  });

  logInfo("transcript.opened", { appointmentId, count: lines.length });

  return { appointmentId, appointment, lines };
}

/**
 * The download name for a transcript.
 *
 * Built from the appointment id and never from the token, because a token in a
 * `Content-Disposition` filename is a working credential in a downloads folder,
 * in a browser's history, and in whatever the operating system does with the
 * name. An appointment id identifies a record; it does not open one.
 */
export function transcriptFilename(appointmentId: string): string {
  return `medilin-transcript-${appointmentId}.pdf`;
}

/** Printed at the foot of every page, and the only line of the PDF that is a policy. */
export const PDF_FOOTER =
  "Confidential. Contains protected health information. Anyone holding this document holds the patient's account of their symptoms.";

/**
 * Render a transcript as a PDF, server-side, or answer no.
 *
 * Server-side because the alternative is a PDF library in the browser, which
 * means the patient's entire conversation downloaded to a device that asked for
 * a picture of it, and a client-side bundle of a compression stack and a font
 * parser to do it. The bytes are built here, from lines that have already been
 * authorised and audited, and the response is `no-store`.
 *
 * What is in the header is worth stating because it is a PHI decision rather
 * than a layout one. The patient's name, date of birth, contact details, phone
 * number and intake notes are *not* in it, even though this is a clinical
 * document and a clinician would want a name on it. These links are bearer
 * credentials that get forwarded -- the tracking page says so on its own footer
 * -- and this application has no clinician account behind any of them. So the
 * export identifies the record by its reference, its status, the call's own
 * timestamp and its language, and then gives the transcript. Adding a patient's
 * name to a document designed to be emailed onward is a decision that should be
 * made when there is an authenticated recipient to make it for.
 *
 * The appointment id *is* in the header, and the line between that and the name
 * is worth being precise about. The id identifies a record; this repository
 * already writes it into the audit trail, into log lines, and into the URL the
 * person reading this document is holding. The token opens a record. So the
 * first can be printed and the second cannot, and that is the whole of the
 * distinction: the PDF is filed against an appointment, not handed out as a
 * link.
 */
export async function buildTranscriptPdf(
  token: string,
  options: OpenTranscriptOptions = {},
): Promise<TranscriptPdf | null> {
  const session = await openTranscript(token, options);
  if (!session) return null;

  // Before the bytes exist, and throwing rather than returning null: a PDF is
  // the one thing this feature produces that leaves the system, and an export
  // nobody can account for is a copy of a patient's medical history that nobody
  // chose to keep.
  await recordAuditEvent({
    actor: AUDIT_ACTORS.linkBearer,
    action: "TRANSCRIPT_EXPORTED",
    resource: transcriptResource(session.appointmentId),
    details: { reason: "track_link", status: session.appointment.status },
  });

  const bytes = renderPdf({
    title: "Call transcript",
    subtitle: "Recording of the booking call for this appointment reference.",
    fields: [
      { label: "Appointment reference", value: session.appointmentId },
      { label: "Appointment status", value: session.appointment.status },
      { label: "Call recorded", value: session.appointment.createdAt.toISOString() },
      { label: "Language of the call", value: session.appointment.patientInfo.language },
      { label: "Lines in this transcript", value: String(session.lines.length) },
    ],
    turns: session.lines.map((line) => ({
      speaker: line.role === "receptionist" ? "Receptionist" : "Patient",
      at: line.at.toISOString().slice(11, 19),
      text: line.text,
    })),
    footer: PDF_FOOTER,
  });

  logInfo("transcript.exported", {
    appointmentId: session.appointmentId,
    count: session.lines.length,
  });

  return {
    bytes,
    filename: transcriptFilename(session.appointmentId),
    lineCount: session.lines.length,
  };
}
