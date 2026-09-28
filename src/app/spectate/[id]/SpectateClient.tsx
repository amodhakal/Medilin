"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAgentRelay } from "@/hooks/useAgentRelay";
import { AgentCard } from "@/components/spectate/AgentCard";
import { CallControls } from "@/components/spectate/CallControls";
import { ConnectionNotice, SessionBadge } from "@/components/spectate/SessionStatus";
import { PatientProfile } from "@/components/spectate/PatientProfile";
import { Transcript } from "@/components/spectate/Transcript";

/**
 * The fields this page renders and forwards to the voice agent.
 *
 * Supplied by the server component, which decrypts the route token. This used
 * to be reconstructed in the browser from a query parameter, behind a
 * hand-copied interface listing the same ten fields as the intake form in a
 * different order, with `insurance` widened to `string`.
 *
 * Deliberately not typed as AppointmentRecord. The two share a shape, but a
 * token decrypts to whatever was sealed, and claiming the validated record
 * type here would assert a guarantee the page has not checked. The server
 * component narrows the decrypted object field by field instead.
 */
export interface SpectatePatient {
  firstName: string;
  lastName: string;
  email: string;
  dob: string;
  phone: string;
  language: string;
  medical_department: string;
  additionalInfo: string;
  insurance: string;
  appointmentDateTime: string;
}

/**
 * The spectate page.
 *
 * Now only composition. The two sockets, the transcript, the turn-taking, and
 * every timer live in @/hooks/useAgentRelay, and the presentational pieces
 * live in @/components/spectate. What is left here is the record this page was
 * given and the decision about what to say to each agent, which belongs with
 * the record it is derived from.
 */
export default function SpectateClient({
  patient,
  patientAgentId,
  receptionistAgentId,
}: {
  patient: SpectatePatient;
  patientAgentId: string;
  receptionistAgentId: string;
}) {
  // Memoised so the relay's effect dependencies are stable. The strings are
  // built here rather than inside the hook so that everything derived from the
  // record is assembled in one place, and the machine only ever sees text.
  const patientOpeningContext = useMemo(
    () =>
      `You are ${patient.firstName} ${patient.lastName}, a patient calling a hospital. ` +
      `Your details: email: ${patient.email}, phone: ${patient.phone}, DOB: ${patient.dob}, ` +
      `insurance: ${patient.insurance}, department: ${patient.medical_department}, ` +
      `preferred language: ${patient.language}. ` +
      `Additional info: ${patient.additionalInfo}. ` +
      `Start the conversation by greeting and explaining why you're calling.`,
    [
      patient.firstName,
      patient.lastName,
      patient.email,
      patient.phone,
      patient.dob,
      patient.insurance,
      patient.medical_department,
      patient.language,
      patient.additionalInfo,
    ]
  );

  const receptionistOpeningContext =
    "You are a hospital receptionist answering calls. Help patients book appointments. " +
    "When they provide their email and preferred language, call the book_appointment tool. " +
    "Be professional and helpful.";

  const patientDynamicVariables = useMemo(
    () => ({ patient_info: JSON.stringify(patient) }),
    [patient]
  );

  const { state, start, stop } = useAgentRelay({
    patientAgentId,
    receptionistAgentId,
    patientOpeningContext,
    receptionistOpeningContext,
    patientDynamicVariables,
  });

  const { phase, error, notice, transcript, speaking, currentText, socket } = state;

  if (error) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center text-red-400 p-6">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center max-w-md shadow-2xl">
          <h2 className="text-xl font-bold mb-2 text-white">Could not start the call</h2>
          <p className="text-sm text-slate-400 mb-6">{error}</p>
          <Link
            href="/"
            className="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-6 py-2.5 rounded-xl text-sm transition-colors"
          >
            Back to the start
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 p-6 lg:p-10 flex flex-col justify-between relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[160px] pointer-events-none" />
      <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-blue-600/10 rounded-full blur-[160px] pointer-events-none" />

      <div className="max-w-7xl mx-auto w-full z-10 flex-1 flex flex-col">
        <header className="flex items-center justify-between gap-4 mb-8 pb-6 border-b border-slate-800/80">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <Link href="/" className="text-xs text-cyan-400 hover:text-cyan-300 font-medium">
                &larr; Exit
              </Link>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <span className="text-xs uppercase tracking-widest text-slate-400 font-semibold">
                Live Spectator Mode
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              Autonomous AI Voice Call
            </h1>
          </div>

          <SessionBadge phase={phase} />
        </header>

        {phase === "degraded" && notice && (
          <ConnectionNotice notice={notice} onDismiss={stop} socket={socket} />
        )}

        <PatientProfile patient={patient} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <AgentCard
            side="patient"
            title="Patient Caller Agent"
            subtitle="Autonomous ElevenLabs Agent"
            status={socket.patient}
            speaking={speaking.patient}
            currentText={currentText.patient}
            idleHint={phase === "idle" ? "Waiting to connect" : "Listening"}
          />
          <AgentCard
            side="receptionist"
            title="Hospital Receptionist"
            subtitle="Booking Agent with Tool Access"
            status={socket.receptionist}
            speaking={speaking.receptionist}
            currentText={currentText.receptionist}
            idleHint={phase === "idle" ? "Waiting to connect" : "Ready to respond"}
          />
        </div>

        <Transcript entries={transcript} />

        <div className="flex justify-center pb-6">
          <CallControls phase={phase} onStart={start} onStop={stop} />
        </div>

        {phase === "stopped" && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 text-center backdrop-blur-xl">
            <h3 className="text-lg font-bold text-white mb-1">Call ended</h3>
            <p className="text-xs text-slate-400 mb-4">
              {transcript.length} {transcript.length === 1 ? "line" : "lines"} were exchanged.
              Reload the page to run it again.
            </p>
            <Link
              href="/"
              className="inline-block bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Start a new consultation
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
