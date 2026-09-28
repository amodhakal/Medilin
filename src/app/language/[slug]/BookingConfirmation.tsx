import { formatMessage, type Messages } from "@/i18n/registry";

/**
 * What the patient sees once the booking is accepted.
 *
 * Its own component, and not a block inside IntakeForm, for two reasons. It is
 * the only part of the form's success path, and the thing it fixed -- an
 * instant `location.assign` that tore the document down before the confirmation
 * could be read, and a spectate URL that existed only in devtools -- is a
 * property of this markup, so this markup is what a test can check. And it
 * takes no state and no timers: the countdown and the redirect are the
 * component's business, this is only how the result is shown.
 *
 * Presentational on purpose. There is no hook in here, which is what lets it be
 * rendered to a string in a test.
 */
export interface BookingConfirmationProps {
  /**
   * The sealed spectate token URL. Opaque: it is a ciphertext that the server
   * can open, not a record with the patient's details in it, which is what
   * makes it safe to link to and to show behind the disclosure.
   */
  url: string;
  appointmentId: string;
  /** Seconds until the automatic redirect, for the countdown line. */
  remaining: number;
  /** Whether the patient has declined the automatic redirect. */
  staying: boolean;
  onStay: () => void;
  onResume: () => void;
  messages: Messages;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function BookingConfirmation({
  url,
  appointmentId,
  remaining,
  staying,
  onStay,
  onResume,
  messages: t,
  headingRef,
}: BookingConfirmationProps) {
  return (
    <div className="text-center">
      <div
        className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full border-2 border-accent text-accent"
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-6 w-6"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>

      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl sm:text-3xl font-bold tracking-tight text-ink mb-2"
      >
        {t.bookedTitle}
      </h1>
      <p className="text-sm text-ink-muted leading-relaxed mb-8 max-w-sm mx-auto">
        {t.bookedBody}
      </p>

      {/*
        A real link, in the page. This is the link the redirect used to make
        for us and the console used to be the only way to recover.
      */}
      <a
        href={url}
        className="w-full inline-flex items-center justify-center bg-accent hover:bg-accent-strong text-white font-semibold py-4 rounded-xl shadow-md transition-colors text-sm tracking-wide"
      >
        {t.joinCall}
      </a>

      <p className="mt-6 font-mono text-xs text-ink-muted break-all">
        {t.reference}: {appointmentId}
      </p>

      {/*
        The token itself, behind a disclosure. It is a bearer credential for the
        patient's own record, so it does not belong printed across the page
        where it can be photographed or read over a shoulder, but it is there
        for the person who needs to open the consultation somewhere else.
      */}
      <details className="mt-4 text-start">
        <summary className="cursor-pointer text-xs font-semibold text-accent hover:text-accent-strong tap-target">
          {t.showLink}
        </summary>
        <p className="mt-2 font-mono text-xs text-ink-muted break-all select-all">
          {url}
        </p>
      </details>

      {/*
        The countdown is hidden from assistive technology and the notice below
        is announced instead. A number that changes every second is noise, not
        information: what a screen reader user needs is that a redirect is
        coming and what they can do about it, both of which are available here
        immediately as a link and a button.
      */}
      {!staying ? (
        <p aria-hidden="true" className="mt-6 text-xs text-ink-muted">
          {remaining === 1
            ? t.redirectingInOne
            : formatMessage(t.redirectingIn, { seconds: remaining })}{" "}
          <button
            type="button"
            onClick={onStay}
            className="font-semibold text-accent hover:text-accent-strong underline tap-target"
          >
            {t.stayHere}
          </button>
        </p>
      ) : (
        <p className="mt-6 text-xs text-ink-muted">
          <button
            type="button"
            onClick={onResume}
            className="font-semibold text-accent hover:text-accent-strong underline tap-target"
          >
            {t.resumeRedirect}
          </button>
        </p>
      )}

      <p role="status" className="sr-only">
        {t.redirectingNotice}
      </p>
    </div>
  );
}
