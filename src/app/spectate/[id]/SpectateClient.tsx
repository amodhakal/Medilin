"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { clientLog } from "@/lib/logger/client";


interface TranscriptMessage {
  id: number;
  role: "patient" | "receptionist";
  text: string;
  timestamp: Date;
}

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

export default function SpectateClient({
  patient,
  patientAgentId,
  receptionistAgentId,
}: {
  patient: SpectatePatient;
  patientAgentId: string;
  receptionistAgentId: string;
}) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [patientSpeaking, setPatientSpeaking] = useState(false);
  const [receptionistSpeaking, setReceptionistSpeaking] = useState(false);
  const [currentPatientText, setCurrentPatientText] = useState("");
  const [currentReceptionistText, setCurrentReceptionistText] = useState("");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [isEnded, setIsEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsARef = useRef<WebSocket | null>(null);
  const wsBRef = useRef<WebSocket | null>(null);
  const transcriptIdRef = useRef(0);
  const waitingForBResponseRef = useRef(false);
  const waitingForAResponseRef = useRef(false);

  useEffect(() => {
    const container = document.getElementById("transcript-container");
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [transcript]);

  const sendMessageToAgent = useCallback((message: string, agent: "A" | "B") => {
    const ws = agent === "A" ? wsARef.current : wsBRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "user_message",
          text: message,
        })
      );
    }
  }, []);

  const connectAgent = useCallback(
    (agentId: string, agent: "A" | "B"): Promise<WebSocket> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`
        );

        ws.onopen = () => {
          clientLog("info", "spectate.agent_connected", { resource: `agent_${agent}` });
          const initData: Record<string, unknown> = {
            type: "conversation_initiation_client_data",
          };
          
          if (agent === "A" && patient) {
            initData.dynamic_variables = {
              patient_info: JSON.stringify(patient),
            };
          }
          
          ws.send(JSON.stringify(initData));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case "conversation_initiation_client_data":
              if (agent === "A") {
                const p = patient;
                const spectateText = `You are ${p.firstName} ${p.lastName}, a patient calling a hospital. Your details: email: ${p.email}, phone: ${p.phone}, DOB: ${p.dob}, insurance: ${p.insurance}, department: ${p.medical_department}, preferred language: ${p.language}. Additional info: ${p.additionalInfo}. Start the conversation by greeting and explaining why you're calling.`;
                setTimeout(() => {
                  ws.send(
                    JSON.stringify({
                      type: "contextual_update",
                      text: spectateText,
                    })
                  );
                }, 500);
              } else if (agent === "B") {
                setTimeout(() => {
                  ws.send(
                    JSON.stringify({
                      type: "contextual_update",
                      text: `You are a hospital receptionist answering calls. Help patients book appointments. When they provide their email and preferred language, call the book_appointment tool. Be professional and helpful.`,
                    })
                  );
                }, 500);
              }
              break;

            case "agent_response":
              const response = data.agent_response_event?.agent_response;
              if (response) {
                const role = agent === "A" ? "patient" : "receptionist";
                setTranscript((prev) => [
                  ...prev,
                  {
                    id: transcriptIdRef.current++,
                    role,
                    text: response,
                    timestamp: new Date(),
                  },
                ]);
                
                if (agent === "A") {
                  setCurrentPatientText(response);
                  setPatientSpeaking(true);
                  waitingForAResponseRef.current = false;
                  
                  setTimeout(() => {
                    setCurrentPatientText("");
                    setPatientSpeaking(false);
                    
                    if (!waitingForBResponseRef.current) {
                      waitingForBResponseRef.current = true;
                      sendMessageToAgent(response, "B");
                    }
                  }, 2500);
                } else {
                  setCurrentReceptionistText(response);
                  setReceptionistSpeaking(true);
                  waitingForBResponseRef.current = false;
                  
                  setTimeout(() => {
                    setCurrentReceptionistText("");
                    setReceptionistSpeaking(false);
                    
                    if (!waitingForAResponseRef.current) {
                      waitingForAResponseRef.current = true;
                      sendMessageToAgent(response, "A");
                    }
                  }, 2500);
                }
              }
              break;

            case "ping":
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    type: "pong",
                    event_id: data.ping_event.event_id,
                  })
                );
              }, data.ping_event.ping_ms);
              break;

            default:
              break;
          }
        };

        ws.onerror = (err) => {
          clientLog("error", "spectate.websocket_error", {
            resource: `agent_${agent}`,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          reject(err);
        };

        ws.onclose = () => {
          if (agent === "A") {
            setPatientSpeaking(false);
          } else {
            setReceptionistSpeaking(false);
          }
        };

        resolve(ws);
      });
    },
    [patient, sendMessageToAgent]
  );

  const startConversation = useCallback(async () => {
    try {
      setIsConnecting(true);
      
      const wsA = await connectAgent(patientAgentId, "A");
      wsARef.current = wsA;
      
      const wsB = await connectAgent(receptionistAgentId, "B");
      wsBRef.current = wsB;

      setIsConnected(true);
      setIsConnecting(false);
    } catch (err) {
      clientLog("error", "spectate.start_failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      setError("Failed to connect to agents. Check console for details.");
      setIsConnecting(false);
    }
  }, [connectAgent, patientAgentId, receptionistAgentId]);

  const stopConversation = useCallback(() => {
    if (wsARef.current) {
      wsARef.current.close();
      wsARef.current = null;
    }
    if (wsBRef.current) {
      wsBRef.current.close();
      wsBRef.current = null;
    }
    setIsConnected(false);
    setIsEnded(true);
    setPatientSpeaking(false);
    setReceptionistSpeaking(false);
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center text-red-400 p-6">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center max-w-md shadow-2xl">
          <h2 className="text-xl font-bold mb-2 text-white">Connection Error</h2>
          <p className="text-sm text-slate-400 mb-6">{error}</p>
          <Link
            href="/"
            className="inline-block bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold px-6 py-2.5 rounded-xl text-sm transition-colors"
          >
            Return Home
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
        {/* Top bar */}
        <header className="flex items-center justify-between mb-8 pb-6 border-b border-slate-800/80">
          <div>
            <div className="flex items-center gap-3">
              <Link href="/" className="text-xs text-cyan-400 hover:text-cyan-300 font-medium">
                &larr; Exit
              </Link>
              <span className="text-slate-600">/</span>
              <span className="text-xs uppercase tracking-widest text-slate-400 font-semibold">
                Live Spectator Mode
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              Autonomous AI Voice Call
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold ${
                isConnected
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : isEnded
                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  : "bg-slate-800 text-slate-400 border border-slate-700"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isConnected
                    ? "bg-emerald-400 animate-pulse"
                    : isEnded
                    ? "bg-amber-400"
                    : "bg-slate-500"
                }`}
              />
              {isConnected ? "Live Session Active" : isEnded ? "Call Completed" : "Ready to Connect"}
            </span>
          </div>
        </header>

        {/* Patient Details Preview */}
        {patient && (
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 mb-8 backdrop-blur-md shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wider font-semibold text-cyan-400">
                Patient Consultation Profile
              </h2>
              <span className="text-xs text-slate-400 bg-slate-800 px-3 py-1 rounded-full">
                Dept: <strong className="text-slate-200">{patient.medical_department}</strong>
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-slate-500 block text-xs">Patient Name</span>
                <span className="font-medium text-slate-200">
                  {patient.firstName} {patient.lastName}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-xs">Email</span>
                <span className="font-medium text-slate-200 truncate block">
                  {patient.email}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-xs">Phone</span>
                <span className="font-medium text-slate-200">{patient.phone}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-xs">Language</span>
                <span className="font-medium text-cyan-300 uppercase">{patient.language}</span>
              </div>
            </div>
          </div>
        )}

        {/* Two Agent Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {/* Patient Agent Card */}
          <div
            className={`rounded-2xl p-6 transition-all duration-300 backdrop-blur-xl border ${
              patientSpeaking
                ? "bg-cyan-950/30 border-cyan-500/60 shadow-xl shadow-cyan-500/10"
                : "bg-slate-900/60 border-slate-800"
            }`}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-2xl shadow-inner">
                  🤖
                </div>
                <div>
                  <h3 className="font-bold text-lg text-white">Patient Caller Agent</h3>
                  <p className="text-xs text-slate-400">Autonomous ElevenLabs Agent</p>
                </div>
              </div>
              {patientSpeaking && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-medium animate-pulse">
                  Speaking
                </span>
              )}
            </div>

            <div className="min-h-[100px] bg-slate-950/50 rounded-xl p-4 border border-slate-800/80 flex flex-col justify-center">
              {currentPatientText ? (
                <p className="text-cyan-100 text-base leading-relaxed">{currentPatientText}</p>
              ) : (
                <p className="text-slate-600 italic text-sm text-center">
                  {isConnected ? "Listening & preparing speech..." : "Waiting to connect..."}
                </p>
              )}
            </div>

            {patientSpeaking && (
              <div className="mt-5 flex items-center justify-center gap-1.5 h-8">
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-cyan-400 rounded-full wave-bar"
                    style={{
                      height: `${[25, 45, 30, 50, 35][i]}px`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Hospital Receptionist Agent Card */}
          <div
            className={`rounded-2xl p-6 transition-all duration-300 backdrop-blur-xl border ${
              receptionistSpeaking
                ? "bg-blue-950/30 border-blue-500/60 shadow-xl shadow-blue-500/10"
                : "bg-slate-900/60 border-slate-800"
            }`}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-2xl shadow-inner">
                  🏥
                </div>
                <div>
                  <h3 className="font-bold text-lg text-white">Hospital Receptionist</h3>
                  <p className="text-xs text-slate-400">Booking Agent with Tool Access</p>
                </div>
              </div>
              {receptionistSpeaking && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/20 text-blue-300 text-xs font-medium animate-pulse">
                  Speaking
                </span>
              )}
            </div>

            <div className="min-h-[100px] bg-slate-950/50 rounded-xl p-4 border border-slate-800/80 flex flex-col justify-center">
              {currentReceptionistText ? (
                <p className="text-blue-100 text-base leading-relaxed">{currentReceptionistText}</p>
              ) : (
                <p className="text-slate-600 italic text-sm text-center">
                  {isConnected ? "Ready to respond..." : "Waiting to connect..."}
                </p>
              )}
            </div>

            {receptionistSpeaking && (
              <div className="mt-5 flex items-center justify-center gap-1.5 h-8">
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-blue-400 rounded-full wave-bar"
                    style={{
                      height: `${[25, 45, 30, 50, 35][i]}px`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Transcript Section */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-xl mb-8 flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
              Real-time Conversation Transcript
            </h2>
            <span className="text-xs text-slate-500">
              {transcript.length} messages exchanged
            </span>
          </div>

          <div
            className="space-y-4 max-h-72 overflow-y-auto pr-2"
            id="transcript-container"
          >
            {transcript.length === 0 ? (
              <div className="text-center py-12 text-slate-600 italic text-sm">
                Transcript entries will appear here once the conversation starts...
              </div>
            ) : (
              transcript.map((msg) => (
                <div
                  key={msg.id}
                  className={`p-4 rounded-xl border transition-all ${
                    msg.role === "receptionist"
                      ? "bg-blue-950/20 border-blue-500/30 text-blue-100 ml-4 sm:ml-12"
                      : "bg-cyan-950/20 border-cyan-500/30 text-cyan-100 mr-4 sm:mr-12"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold tracking-wide uppercase">
                      {msg.role === "receptionist" ? "🏥 Hospital Receptionist" : "🤖 Patient Caller Agent"}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {msg.timestamp.toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{msg.text}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex justify-center pb-6">
          {!isConnected && !isEnded ? (
            <button
              onClick={startConversation}
              disabled={isConnecting}
              className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold px-10 py-4 rounded-2xl shadow-xl shadow-cyan-500/25 disabled:opacity-50 transition-all duration-300 cursor-pointer text-base flex items-center gap-3"
            >
              {!patient ? (
                "Loading Patient Data..."
              ) : isConnecting ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Establishing Secure WebSockets...
                </>
              ) : (
                <>
                  <span className="text-xl">🎙️</span> Start Autonomous Voice Conversation
                </>
              )}
            </button>
          ) : isConnected ? (
            <button
              onClick={stopConversation}
              className="bg-red-600 hover:bg-red-500 text-white font-bold px-10 py-4 rounded-2xl shadow-xl shadow-red-600/25 transition-all duration-300 cursor-pointer text-base flex items-center gap-2"
            >
              <span>🛑</span> Stop Conversation
            </button>
          ) : null}
        </div>

        {isEnded && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 text-center backdrop-blur-xl">
            <h3 className="text-lg font-bold text-white mb-1">Conversation Complete</h3>
            <p className="text-xs text-slate-400 mb-4">
              The appointment has been successfully booked and confirmation sent.
            </p>
            <Link
              href="/"
              className="inline-block bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Start New Consultation
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
