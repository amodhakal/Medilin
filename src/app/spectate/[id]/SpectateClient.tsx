"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo } from "react";
import { useAgentRelay, type AgentSide } from "@/hooks/useAgentRelay";
import {
  createAgentSocketFactory,
  type AgentSocketFactory,
  type VoiceCredential,
} from "@/lib/voice/agent-socket";
import { clientLog } from "@/lib/logger/client";
import { AgentCard } from "@/components/spectate/AgentCard";
import { CallControls } from "@/components/spectate/CallControls";
import { SessionBadge, SessionNotice } from "@/components/spectate/SessionStatus";
import { PatientProfile } from "@/components/spectate/PatientProfile";
import { SessionLink } from "@/components/spectate/SessionLink";
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

/** Where a browser asks this app's server for a signed conversation URL. */
const SESSION_ENDPOINT = "/api/voice/session";

/**
 * The spectate page.
 *
 * Now only composition. The two sockets, the transcript, the turn-taking, and
 * every timer live in @/hooks/useAgentRelay, and the presentational pieces
 * live in @/components/spectate. What is left here is the record this page was
 * given, the decision about what to say to each agent, and -- since #15 -- the
 * one socket factory that replaced a pair of agent ids.
 */
export default function SpectateClient({
  patient,
  voiceAvailable,
  sessionToken,
}: {
  patient: SpectatePatient;
  /** Whether this deployment has a voice credential at all. */
  voiceAvailable: boolean;
  /** The sealed spectate token, which is what authorises a voice session. */
  sessionToken: string;
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

  /**
   * Ask the server for a signed URL for one side.
   *
   * The only thing the browser learns from this is a `wss://` URL that stops
   * working in a minute. The agent id stays in the server's configuration and
   * the API key stays in the server's environment; neither is in this module,
   * in the page's props, or in anything the browser can read.
   *
   * Throws on any non-OK answer, including the 503 a deployment without a voice
   * credential gets, and including the 403 for a token that is not a booking.
   * The socket factory turns that into a failed connect, which the relay
   * already reports, so no error text is invented here.
   */
  const mintCredential = useCallback(
    async (side: AgentSide): Promise<VoiceCredential> => {
      const response = await fetch(SESSION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side, session: sessionToken }),
      });

      if (!response.ok) {
        throw new Error(`voice session refused: ${response.status}`);
      }

      const body = (await response.json()) as { url?: unknown; expiresAt?: unknown };
      if (typeof body.url !== "string" || typeof body.expiresAt !== "number") {
        throw new Error("voice session response was not a credential");
      }

      return { url: body.url, expiresAt: body.expiresAt };
    },
    [sessionToken],
  );

  /**
   * The factory, built once.
   *
   * `useMemo` with nothing but `mintCredential` in the dependency list, which
   * is what keeps it referentially stable: it goes into the relay's
   * configuration, and a factory that changed identity on every render would
   * re-run the relay's reconfigure effect forever. The React Compiler rewrites
   * this into exactly this, so the stability is a property of the dependency
   * list and not of the hook.
   */
  const sockets = useMemo<AgentSocketFactory | null>(() => {
    if (!voiceAvailable) return null;

    return createAgentSocketFactory({
      mint: mintCredential,
      onFault: (fault) => clientLog("warn", "voice.socket_fault", { resource: fault }),
    });
  }, [mintCredential, voiceAvailable]);

  /**
   * Fetch the credentials while the patient reads the page.
   *
   * The one cost of asking the server instead of the vendor is a round trip
   * between pressing Start and the socket existing. Doing it here puts that
   * round trip on page load, where nobody is waiting on it, and the factory
   * reuses what it fetches.
   *
   * Skipped when this deployment has no voice credential: those sides cannot be
   * opened, and the relay's own failure message is the honest one.
   */
  useEffect(() => {
    if (!sockets) return;
    sockets.warm();
    return () => {
      sockets.clear();
    };
  }, [sockets]);

  const openSocket = useMemo(
    () => (sockets ? (side: AgentSide) => sockets.open(side) : undefined),
    [sockets],
  );

  const { state, start, stop, reconnect, reconnectAll } = useAgentRelay({
    createSocket: openSocket,
    patientOpeningContext,
    receptionistOpeningContext,
    patientDynamicVariables,
  });

  const { phase, error, notice, transcript, speaking, currentText, socket, stalled, awaiting } =
    state;

  // The relay exposes one `reconnect` for both sides; the cards each know
  // which agent they are, so the handlers are made here rather than the
  // machine taking a component's concerns.
  const reconnectPatient = useCallback(() => reconnect("patient"), [reconnect]);
  const reconnectReceptionist = useCallback(() => reconnect("receptionist"), [reconnect]);

  /**
   * What a card says when it has nothing on it.
   *
   * The relay knows which side owes it a reply, so the card says that rather
   * than a flat "Listening". Watching a demo stall, the operator can see
   * whether it is waiting on the patient agent or the receptionist instead of
   * guessing from two identical cards.
   */
  const idleHint = (side: "patient" | "receptionist"): string => {
    if (phase === "idle") return "Waiting to connect";
    if (awaiting === side) return "Owes a reply";
    return "Listening";
  };

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

        {notice && (phase === "degraded" || stalled) && (
          <SessionNotice
            notice={notice}
            stalled={stalled && phase !== "degraded"}
            socket={socket}
            onReconnect={reconnectAll}
            onDismiss={stop}
          />
        )}

        <SessionLink />

        <PatientProfile patient={patient} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <AgentCard
            side="patient"
            title="Patient Caller Agent"
            subtitle="Autonomous ElevenLabs Agent"
            status={socket.patient}
            speaking={speaking.patient}
            currentText={currentText.patient}
            idleHint={idleHint("patient")}
            onReconnect={reconnectPatient}
          />
          <AgentCard
            side="receptionist"
            title="Hospital Receptionist"
            subtitle="Booking Agent with Tool Access"
            status={socket.receptionist}
            speaking={speaking.receptionist}
            currentText={currentText.receptionist}
            idleHint={idleHint("receptionist")}
            onReconnect={reconnectReceptionist}
          />
        </div>

        <Transcript entries={transcript} />

        <div className="flex justify-center pb-6">
          <CallControls phase={phase} onStart={start} onStop={stop} />
        </div>

        {phase === "stopped" && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 text-center backdrop-blur-xl">
            <h3 className="text-lg font-bold text-white mb-1">Call ended</h3>
            <p className="text-xs text-slate-400 mb-1">
              {transcript.length} {transcript.length === 1 ? "line" : "lines"} were exchanged.
            </p>
            <p className="text-xs text-slate-500 mb-4">
              The transcript stays in this tab&rsquo;s memory for the rest of the session. It is
              not written to storage and it is gone on reload, because it is the
              patient&rsquo;s appointment and somewhere else to keep it is a decision
              this page should not make.
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
