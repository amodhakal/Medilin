"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
import { pendingTranscriptLines, type RelayTranscriptEntry } from "./transcriptSync";

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

/** Where a browser hands the finished lines of a call to be kept. */
const TRANSCRIPT_ENDPOINT = "/api/transcript";

/**
 * How long to wait before sending a batch.
 *
 * Long enough that a call's rapid exchanges go out together, short enough that
 * the last thing said before a tab is closed is not the thing that is lost. This
 * is the only window in which a line can go missing: the relay finalises a line
 * and the page can be closed before the next flush, and the alternative -- a
 * request per line -- would put a round trip between the call and its record for
 * every sentence in it.
 */
const TRANSCRIPT_FLUSH_MS = 750;

/**
 * The spectate page.
 *
 * Now only composition. The two sockets, the transcript, the turn-taking, and
 * every timer live in @/hooks/useAgentRelay, and the presentational pieces
 * live in @/components/spectate. What is left here is the record this page was
 * given, the decision about what to say to each agent, and -- since #15 -- the
 * one socket factory that replaced a pair of agent ids.
 *
 * Since #57 it is also the only place the finished lines of a call leave the
 * browser, which is why the effect that does it is here rather than in the hook:
 * the hook is a state machine with no opinion about the network, and the page is
 * where the page's own endpoints are already known.
 */
export default function SpectateClient({
  patient,
  voiceAvailable,
  sessionToken,
  transcriptAvailable,
}: {
  patient: SpectatePatient;
  /** Whether this deployment has a voice credential at all. */
  voiceAvailable: boolean;
  /** The sealed spectate token, which is what authorises a voice session. */
  sessionToken: string;
  /**
   * Whether this link can address a stored transcript at all.
   *
   * Decided on the server, because deciding it in the browser would mean asking
   * the server -- or worse, guessing. A version 1 token is the record sealed into
   * the URL with nothing stored behind it, so there is no transcript to replay
   * for it, and a link on the page that always 404s is worse than no link.
   */
  transcriptAvailable: boolean;
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
   * The lines the server has acknowledged, and the ones a request is carrying.
   *
   * Two sets rather than one, and the reason is the difference between losing a
   * line and sending it twice. A line is only added to `sent` when the server has
   * said it stored it, so a request that fails is retried on the next flush; and
   * the store keys a line by its position, so a line that *is* sent twice corrects
   * itself rather than appearing twice in a patient's record. Marking a line as
   * sent before the request would have been simpler and would have dropped the
   * lines whose response nobody saw -- which on a flaky connection is most of a
   * call.
   *
   * Refs rather than state: this is bookkeeping for an effect, and putting it in
   * state would re-render the whole page every time a line was acknowledged.
   */
  const sentLines = useRef<Set<number>>(new Set());
  const linesInFlight = useRef<Set<number>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Hand the finished lines to the server.
   *
   * The failure path is quiet on purpose. A transcript that could not be saved is
   * a problem, and a call operator watching a demo is not the person who can fix
   * it -- so it is logged and the page says what it can honestly say ("this call
   * is not being written down") rather than pretending. `clientLog` runs the same
   * allowlist as the server logger, and the fields here are the appointment's
   * absence and a count: there is no transcript text in this call, which is the
   * redaction posture for a surface whose payload is the PHI.
   */
  const flushTranscript = useCallback(
    async (entries: readonly RelayTranscriptEntry[]) => {
      const pending = pendingTranscriptLines(entries, sentLines.current).filter(
        (line) => !linesInFlight.current.has(line.seq),
      );
      if (pending.length === 0) return;

      for (const line of pending) linesInFlight.current.add(line.seq);

      try {
        const response = await fetch(TRANSCRIPT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: sessionToken, entries: pending }),
        });

        if (!response.ok) throw new Error(`transcript refused: ${response.status}`);

        for (const line of pending) sentLines.current.add(line.seq);
      } catch (error) {
        // Left unsent on purpose, so the next flush tries again. A transient
        // network failure should cost a line a moment, not a call.
        clientLog("warn", "transcript.flush_failed", {
          errorName: error instanceof Error ? error.name : "unknown",
          count: pending.length,
        });
      } finally {
        for (const line of pending) linesInFlight.current.delete(line.seq);
      }
    },
    [sessionToken],
  );

  /**
   * Flush on a short debounce, and immediately when the call is stopped.
   *
   * The debounce coalesces a burst of finalisations into one request; the
   * immediate flush on `stopped` is what makes the last exchange of a call
   * durable rather than dependent on a timer that is about to be cleared.
   */
  useEffect(() => {
    if (transcript.length === 0) return;

    if (phase === "stopped") {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      void flushTranscript(transcript);
      return;
    }

    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flushTranscript(transcript);
    }, TRANSCRIPT_FLUSH_MS);

    return () => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [transcript, phase, flushTranscript]);

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
            {/*
              The copy here used to say the transcript "is not written to storage
              and is gone on reload, because it is the patient's appointment and
              somewhere else to keep it is a decision this page should not make".
              #57 is that decision, taken deliberately rather than deferred: it is
              envelope-encrypted per line, audited on every read and every
              export, deleted with the appointment, and reachable only through
              the same link this page already holds. So it says what is now true.
            */}
            <p className="text-xs text-slate-500 mb-4">
              {transcriptAvailable
                ? "The call has been written down, encrypted, and kept with the appointment. Open it again or take a copy with the links below."
                : "This link cannot address a stored transcript, so the call is not being written down. That is the case for links minted before the clinic had a database."}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {transcriptAvailable && (
                <>
                  <Link
                    href={`/transcript/${sessionToken}`}
                    className="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors"
                  >
                    Open the transcript
                  </Link>
                  <a
                    href={`/api/transcript/${sessionToken}/pdf`}
                    rel="nofollow"
                    className="inline-block bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-5 py-2.5 rounded-xl transition-colors"
                  >
                    Download as PDF
                  </a>
                </>
              )}
              <Link
                href="/"
                className="inline-block bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-6 py-2.5 rounded-xl transition-colors"
              >
                Start a new consultation
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
