"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { submitIntakeForm } from "@/app/actions";
import { BookingConfirmation } from "@/app/language/[slug]/BookingConfirmation";
import {
  collectIssues,
  errorId,
  hasFieldErrors,
  summaryEntries,
  type FieldErrors,
} from "@/app/language/[slug]/formIssues";
import { createSubmitGate } from "@/app/language/[slug]/submitGate";
import {
  DEPARTMENT_OPTIONS,
  FIELD_LABELS,
  INTAKE_FIELDS,
  htmlLang,
  type IntakeFieldName,
  type LiveLanguage,
  type LiveLanguageSlug,
} from "@/i18n/registry";
import { clientLog } from "@/lib/logger/client";
import type { FieldIssue } from "@/lib/validation/parse";
import type { VoiceMessages } from "../copy";

/**
 * Booking an appointment by answering out loud.
 *
 * Four steps and one rule: the review step is the form. Not a copy of it, and not
 * a summary of it -- the same inputs, with the same `name` attributes, the same
 * labels out of the same registry, the same per-field validation, and the same
 * `submitIntakeForm` server action doing the booking. Everything the form can
 * book, this books, and the booking pipeline cannot tell the two apart.
 *
 * That is the whole design decision of #61, and it is why this file contains no
 * appointment logic at all. What it adds is two things the form does not have:
 *
 *   - A recording, via `MediaRecorder`, posted to /api/voice/intake. The vendor
 *     is never dialled from the browser and no credential is ever in this bundle.
 *   - A read-back, via /api/voice/speak. Somebody who has just dictated a date of
 *     birth is somebody who has just had a chance to get it wrong without
 *     noticing, and hearing it back is the cheapest way to catch that before a
 *     confirmation goes to an address that is not theirs.
 *
 * Both are server-side and both are optional: a browser that cannot record, or a
 * deployment with no voice credential, still gets a working route to the form.
 */

const INTAKE_ENDPOINT = "/api/voice/intake";
const SPEAK_ENDPOINT = "/api/voice/speak";

/** How long the confirmation waits before offering the consultation. */
const REDIRECT_SECONDS = 20;

/** How long a recording may run before this page stops it. */
const MAX_RECORDING_MS = 120_000;

/** Client-side mirror of the server's cap, so the button disables rather than 413s. */
const MAX_SPEECH_CHARACTERS = 600;

/**
 * Where the patient is.
 *
 * `listening` covers both halves of `working`, because they share a screen and
 * a stop button and differ only in what that screen says. Collapsing them into
 * one state is what let the screen read "Reading your answers" while the
 * microphone was still open, which is a small lie told to somebody who is
 * mid-sentence.
 */
type Step = "record" | "listening" | "working" | "review" | "booked";

/** What /api/voice/intake answers with. The same field names the form posts. */
interface Draft {
  transcript: string;
  language: string;
  fields: Record<string, string>;
  issues: FieldIssue[];
  complete: boolean;
}

interface Booking {
  url: string;
  appointmentId: string;
}

const LABEL =
  "block text-xs font-semibold text-ink-soft uppercase tracking-wider mb-1.5";
const CONTROL =
  "w-full bg-surface-sunken border border-rule rounded-xl px-4 py-3 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors";
const CONTROL_INVALID =
  "border-danger-rule border-2 focus:border-danger focus:ring-danger/20 bg-surface";
const ERROR_TEXT = "mt-1.5 text-xs font-medium text-danger";

export default function VoiceIntake({
  slug,
  language,
  messages: copy,
}: {
  slug: LiveLanguageSlug;
  language: LiveLanguage;
  messages: VoiceMessages;
}) {
  const t = language.messages;

  const [step, setStep] = useState<Step>("record");
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [unattached, setUnattached] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [booked, setBooked] = useState<Booking | null>(null);
  const [staying, setStaying] = useState(false);
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);
  /**
   * How long the read-back would be, in state rather than read off the form
   * during render.
   *
   * The form is uncontrolled, so its current values are only reachable through a
   * ref, and the React Compiler's rule against reading one while rendering is
   * there for a good reason. Measuring in an effect and in the change handler
   * gives the button the same answer without rendering from a ref.
   */
  const [readBackLength, setReadBackLength] = useState(0);

  const formRef = useRef<HTMLFormElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const confirmationRef = useRef<HTMLHeadingElement | null>(null);
  const gate = useRef(createSubmitGate());
  // A ref rather than state: the recorder is not something to render, and a
  // `MediaRecorder` in state would be re-created on every render that touched
  // it, which is exactly while a recording is in progress.
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  /** Stop the microphone. Safe to call when nothing is recording. */
  const releaseMicrophone = useCallback(() => {
    recorder.current?.stream.getTracks().forEach((track) => track.stop());
    recorder.current = null;
  }, []);

  /**
   * Unmount: detach the recorder's handlers, then stop the microphone.
   *
   * In that order, and the order is the point. Stopping the tracks makes the
   * recorder fire `onstop`, which is wired to upload a recording -- so an
   * unmount during a recording would otherwise post a half-finished blob to the
   * vendor and then set state on a component that is no longer there. Nulling
   * the handlers first means the microphone still turns off and nothing is
   * uploaded.
   */
  useEffect(
    () => () => {
      if (recorder.current) {
        recorder.current.ondataavailable = null;
        recorder.current.onstop = null;
      }
      releaseMicrophone();
    },
    [releaseMicrophone],
  );

  useEffect(() => {
    if (!booked || staying) return;

    const countdown = setInterval(() => {
      setRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    const redirect = setTimeout(() => {
      window.location.assign(booked.url);
    }, REDIRECT_SECONDS * 1000);

    return () => {
      clearInterval(countdown);
      clearTimeout(redirect);
    };
  }, [booked, staying]);

  useEffect(() => {
    if (booked) confirmationRef.current?.focus();
  }, [booked]);

  /**
   * What the read-back would say, from the form as it stands.
   *
   * One function for both the button's disabled state and the request, because
   * two would drift: a button that measures the values while the request sends
   * the values and their labels is a button that enables a request the server
   * then refuses with a 400 the patient cannot act on.
   */
  const readBackText = useCallback(
    (form: HTMLFormElement | null): string => {
      if (!form) return "";
      const values = new FormData(form);

      return INTAKE_FIELDS.map((field) => {
        const value = String(values.get(field) ?? "").trim();
        return value ? `${t[FIELD_LABELS[field]]}: ${value}` : "";
      })
        .filter(Boolean)
        .join(". ");
    },
    [t],
  );

  // Measured once when the review appears -- the inputs are pre-filled, so
  // nothing fires a change event for them -- and again on every edit.
  useEffect(() => {
    if (step !== "review") return;
    setReadBackLength(readBackText(formRef.current).length);
  }, [step, draft, readBackText]);

  const startRecording = async () => {
    setProblem(null);

    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setProblem(copy.notSupported);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // A refused permission and a missing microphone are the same thing to the
      // person in front of the screen, and the difference is not something this
      // page can help with.
      setProblem(copy.micRefused);
      return;
    }

    chunks.current = [];
    const instance = new MediaRecorder(stream);
    recorder.current = instance;

    instance.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    instance.onstop = () => {
      void sendRecording(new Blob(chunks.current, { type: instance.mimeType }));
    };

    instance.start();
    setRecording(true);
    setStep("listening");

    // A recording with no end is a patient who walked away from a tab, a meter
    // that keeps running, and a vendor bill that keeps going. The server caps
    // the upload; this caps the meter.
    setTimeout(() => {
      if (recorder.current === instance && instance.state === "recording") instance.stop();
    }, MAX_RECORDING_MS);
  };

  const sendRecording = async (audio: Blob) => {
    releaseMicrophone();
    setRecording(false);
    setStep("working");

    try {
      const body = new FormData();
      // The name matters: the server reads the part by it, and it is the same
      // name a `MediaRecorder` blob would be given anywhere else.
      body.set("audio", audio, "recording.webm");
      body.set("language", slug);

      const response = await fetch(INTAKE_ENDPOINT, { method: "POST", body });

      if (!response.ok) {
        setProblem(response.status === 413 ? copy.tooLong : copy.nothingHeard);
        setStep("record");
        return;
      }

      const answer = (await response.json()) as Draft;
      setTranscript(answer.transcript);
      setDraft(answer);
      setErrors(collectIssues(answer.issues).byField);
      setStep("review");
    } catch {
      // A dropped connection, a platform error, a serialization failure. All
      // indistinguishable here and all one message: the recording is not
      // recoverable and the form is one click away.
      clientLog("error", "voice.intake_failed", { language: slug });
      setProblem(copy.nothingHeard);
      setStep("record");
    }
  };

  const stopRecording = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  /**
   * Read the filled-in form back to the patient.
   *
   * Built from the form's own current values rather than from the draft, so it
   * reads what is on screen. The length is checked before the request, because
   * the server's cap is a 400 and a disabled button is a better answer than a
   * failure.
   */
  const readBack = async () => {
    const spoken = readBackText(formRef.current);
    if (spoken.length === 0 || spoken.length > MAX_SPEECH_CHARACTERS) return;

    setProblem(null);
    setSpeaking(true);
    try {
      const response = await fetch(SPEAK_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: spoken }),
      });
      if (!response.ok) {
        setProblem(copy.speakFailed);
        return;
      }

      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      // Revoked on `ended` and on `error` as well as here: an object URL that
      // is never released is the blob's audio sitting in this tab's memory for
      // the rest of the session.
      const release = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
      };
      audio.addEventListener("ended", release);
      audio.addEventListener("error", release);
      await audio.play();
    } catch {
      setProblem(copy.speakFailed);
    } finally {
      setSpeaking(false);
    }
  };

  /**
   * Book it, through the form's own server action.
   *
   * `new FormData(form)` is the form's own serialisation, and `language` is
   * appended the way the form appends it. From here the two paths are
   * indistinguishable: the same validation, the same `bookAppointment`, the same
   * confirmation or partial-success handling.
   */
  const confirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!gate.current.begin()) return;

    try {
      const body = new FormData(event.currentTarget);
      body.set("language", slug);
      const result = await submitIntakeForm(body);

      if (!result.ok) {
        // A partial success is not a rejection: the appointment exists and only
        // the email failed, so the patient still needs the link. Same handling
        // as the form, for the same reason.
        if (result.spectateUrl && result.appointmentId) {
          clientLog("warn", "intake.confirmation_undelivered", { language: slug });
          setErrors({});
          setUnattached([result.error]);
          setBooked({ url: result.spectateUrl, appointmentId: result.appointmentId });
          setRemaining(REDIRECT_SECONDS);
          setStaying(false);
          return;
        }

        const collected = collectIssues(result.issues);
        setErrors(collected.byField);
        setUnattached(
          result.issues.length > 0 ? collected.unattached : [result.error],
        );
        clientLog("warn", "intake.submit_rejected", { language: slug });
        summaryRef.current?.focus();
        return;
      }

      setErrors({});
      setUnattached([]);
      setBooked({ url: result.spectateUrl, appointmentId: result.appointmentId });
      setRemaining(REDIRECT_SECONDS);
      setStaying(false);
    } catch {
      // The action can throw before it returns its union. A page that looks
      // ready to send again while nothing was sent is the bug this used to have.
      clientLog("error", "intake.submit_failed", { language: slug });
      setUnattached([t.submitFailed]);
    } finally {
      gate.current.end();
    }
  };

  const canReadBack =
    !speaking &&
    step === "review" &&
    readBackLength > 0 &&
    readBackLength <= MAX_SPEECH_CHARACTERS;

  if (booked) {
    return (
      <div className="bg-surface border border-rule rounded-3xl p-8 shadow-xl">
        <BookingConfirmation
          url={booked.url}
          appointmentId={booked.appointmentId}
          remaining={remaining}
          staying={staying}
          onStay={() => setStaying(true)}
          onResume={() => {
            setRemaining(REDIRECT_SECONDS);
            setStaying(false);
          }}
          messages={t}
          headingRef={confirmationRef}
        />
      </div>
    );
  }

  return (
    <div className="bg-surface border border-rule rounded-3xl p-8 shadow-xl">
      <div className="mb-6 text-center">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink mb-2">
          {step === "review" ? copy.reviewTitle : copy.title}
        </h1>
        <p className="text-sm text-ink-muted">{copy.subtitle}</p>
      </div>

      {problem && (
        <p role="alert" className="mb-6 rounded-2xl border-2 border-danger-rule bg-danger-soft p-4 text-sm text-danger-ink">
          {problem}
        </p>
      )}

      {/*
        The error summary, exactly as the form renders it: `role="alert"` so it
        is announced, and focusable so it can be moved to. A summary a screen
        reader user has to go looking for is a decoration.
      */}
      {(hasFieldErrors(errors) || unattached.length > 0) && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="mb-6 rounded-2xl border-2 border-danger-rule bg-danger-soft p-4 text-start"
        >
          <h2 className="text-sm font-bold text-danger-ink">{t.fixErrors}</h2>
          {hasFieldErrors(errors) && (
            <ul className="mt-2 space-y-1 text-sm text-danger-ink list-disc ps-5">
              {summaryEntries(errors, t).map((entry) => (
                <li key={entry.field}>
                  <a href={entry.href} className="underline font-semibold hover:text-danger-ink">
                    {entry.label}
                  </a>
                  {": "}
                  <span>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
          {unattached.map((message) => (
            <p key={message} className="mt-2 text-sm text-danger-ink">
              {message}
            </p>
          ))}
        </div>
      )}

      {/*
        Step one. One control, and it is a button rather than a form: a
        `MediaRecorder` is a user gesture's answer, and it needs the click.
      */}
      {step === "record" && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => void startRecording()}
            className="w-full bg-accent hover:bg-accent-strong text-white font-semibold py-5 rounded-xl shadow-md transition-colors text-sm tracking-wide inline-flex items-center justify-center gap-3"
          >
            <span aria-hidden="true">●</span>
            {copy.record}
          </button>
          <p className="mt-4 text-sm text-ink-muted">
            <Link href={`/language/${slug}`} className="text-accent font-semibold hover:underline">
              {copy.useTheForm}
            </Link>
          </p>
        </div>
      )}

      {(step === "listening" || step === "working") && (
        <div className="text-center py-6" aria-busy>
          <svg
            className="animate-spin motion-reduce:animate-none h-6 w-6 mx-auto mb-4 text-accent"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-90"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p className="text-sm text-ink-soft">
            {recording ? copy.recording : copy.working}
          </p>
          {/* Only while the microphone is actually open. Once the recording has
              been sent there is nothing to stop, and a Stop button that does
              nothing is a control that lies about what the page is doing. */}
          {recording && (
            <button
              type="button"
              onClick={stopRecording}
              className="mt-6 inline-flex items-center gap-2 bg-surface-sunken border border-rule text-ink font-semibold px-5 py-3 rounded-xl text-sm transition-colors"
            >
              {copy.stop}
            </button>
          )}
          {/* Announced, not just displayed: a patient who cannot see the
              spinner still needs to know the microphone is open. */}
          <p role="status" aria-live="polite" className="sr-only">
            {recording ? copy.recording : copy.working}
          </p>
        </div>
      )}

      {/*
        Step two. A form, with the form's field names, pre-filled with what was
        heard and editable in every particular -- a model that heard a date
        wrong is a model that has to be overruleable by the patient.
      */}
      {step === "review" && draft && (
        <form
          ref={formRef}
          onSubmit={confirm}
          onChange={(event) =>
            setReadBackLength(readBackText(event.currentTarget).length)
          }
          className="space-y-4"
        >
          {transcript && (
            <details className="text-start rounded-2xl bg-surface-sunken border border-rule p-4">
              <summary className="cursor-pointer text-xs font-semibold text-accent tap-target">
                {copy.transcript}
              </summary>
              {/* The patient's own words, so they can see what was heard. */}
              <p lang={htmlLang(language)} dir="auto" className="mt-2 text-sm text-ink-soft">
                {transcript}
              </p>
            </details>
          )}

          {unattached.length === 0 && hasFieldErrors(errors) && (
            <p className="text-start text-xs font-semibold text-danger">{copy.notHeard}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field name="firstName" label={t.firstName} value={draft.fields.firstName} error={errors.firstName} autoComplete="given-name" />
            <Field name="lastName" label={t.lastName} value={draft.fields.lastName} error={errors.lastName} autoComplete="family-name" />
          </div>

          <Field name="email" label={t.email} value={draft.fields.email} error={errors.email} type="email" autoComplete="email" ltr />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field name="dob" label={t.dob} value={draft.fields.dob} error={errors.dob} type="date" />
            <Field name="phone" label={t.phone} value={draft.fields.phone} error={errors.phone} type="tel" autoComplete="tel" ltr />
          </div>

          <fieldset>
            <legend className={LABEL}>{t.insurance}</legend>
            <div className="flex flex-wrap gap-6 bg-surface-sunken border border-rule rounded-xl p-3.5">
              {(["yes", "no"] as const).map((value) => (
                <label key={value} className="flex items-center cursor-pointer text-sm font-medium text-ink">
                  <input
                    type="radio"
                    name="insurance"
                    value={value}
                    defaultChecked={draft.fields.insurance === value}
                    className="me-2 accent-accent w-4 h-4"
                  />
                  {value === "yes" ? t.yes : t.no}
                </label>
              ))}
            </div>
            {errors.insurance && <p className={ERROR_TEXT}>{errors.insurance}</p>}
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              name="appointmentDateTime"
              label={t.appointmentDateTime}
              value={draft.fields.appointmentDateTime}
              error={errors.appointmentDateTime}
              type="datetime-local"
              ltr
            />
            <div>
              <label htmlFor="medical_department" className={LABEL}>
                {t.whoToVisit}
              </label>
              <select
                id="medical_department"
                name="medical_department"
                defaultValue={draft.fields.medical_department ?? ""}
                aria-invalid={errors.medical_department ? true : undefined}
                className={`${CONTROL} ${errors.medical_department ? CONTROL_INVALID : ""}`}
              >
                <option value="">{t.selectOption}</option>
                {DEPARTMENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t[option.messageKey]}
                  </option>
                ))}
              </select>
              {errors.medical_department && (
                <p id={errorId("medical_department")} className={ERROR_TEXT}>
                  {errors.medical_department}
                </p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="additionalInfo" className={LABEL}>
              {t.additionalInfo}
            </label>
            <textarea
              id="additionalInfo"
              name="additionalInfo"
              rows={3}
              dir="auto"
              defaultValue={draft.fields.additionalInfo ?? ""}
              className={`${CONTROL} resize-none`}
            />
            {errors.additionalInfo && (
              <p id={errorId("additionalInfo")} className={ERROR_TEXT}>
                {errors.additionalInfo}
              </p>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="submit"
              disabled={speaking}
              aria-disabled={speaking}
              className="flex-1 bg-accent hover:bg-accent-strong disabled:bg-accent/60 text-white font-semibold py-4 rounded-xl shadow-md transition-colors text-sm tracking-wide"
            >
              {copy.confirm}
            </button>
            <button
              type="button"
              onClick={() => void readBack()}
              disabled={!canReadBack}
              aria-disabled={!canReadBack}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-surface-sunken border border-rule text-ink font-semibold py-4 rounded-xl transition-colors text-sm disabled:opacity-60"
            >
              {speaking ? copy.speaking : copy.listen}
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setTranscript("");
              setErrors({});
              setProblem(null);
              setStep("record");
            }}
            className="w-full text-xs font-semibold text-accent hover:underline tap-target py-2"
          >
            {copy.recordAgain}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * One labelled input, pre-filled with what was heard.
 *
 * `defaultValue` rather than a controlled value on purpose: this form is
 * submitted as a DOM form and the recording step is not a form state machine.
 * That is the same choice the intake form makes, and it is what lets the two
 * share `submitIntakeForm` instead of each inventing a serialisation.
 */
function Field({
  name,
  label,
  value,
  error,
  type = "text",
  autoComplete,
  ltr = false,
}: {
  name: IntakeFieldName;
  label: string;
  value: string | undefined;
  error: string | undefined;
  type?: string;
  autoComplete?: string;
  ltr?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className={LABEL}>
        {label}
      </label>
      <input
        type={type}
        id={name}
        name={name}
        defaultValue={value ?? ""}
        autoComplete={autoComplete}
        dir={ltr ? "ltr" : "auto"}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId(name) : undefined}
        className={`${CONTROL} ${error ? CONTROL_INVALID : ""}`}
      />
      {error && (
        <p id={errorId(name)} className={ERROR_TEXT}>
          {error}
        </p>
      )}
    </div>
  );
}
