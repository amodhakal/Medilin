"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { submitIntakeForm } from "@/app/actions";
import { clientLog } from "@/lib/logger/client";
import Link from "next/link";

import { LowBandwidthToggle } from "@/i18n/display-preferences";
import {
  DEPARTMENT_OPTIONS,
  MAX_HOUSEHOLD_SIZE,
  RELATIONSHIP_OPTIONS,
  formatMessage,
  htmlLang,
  type IntakeFieldName,
  type LiveLanguage,
  type LiveLanguageSlug,
  type Messages,
} from "@/i18n/registry";
import {
  collectIssues,
  errorId,
  fieldId,
  hasFieldErrors,
  summaryEntries,
  type FieldErrors,
} from "./formIssues";
import {
  DEPENDENT_FIELDS,
  nextHouseholdSize,
  peopleCount,
  type DependentFieldName,
  dependentFieldName,
} from "./household";
import { BookingConfirmation } from "./BookingConfirmation";
import { createSubmitGate } from "./submitGate";

/**
 * The intake form for one language.
 *
 * A client component, because submitting it is a server action and because
 * `submitIntakeForm` returns a discriminated union that decides what happens
 * next. The route that decides *which* language this is a server component:
 * `page.tsx` resolves the slug and calls `notFound()` for anything it does
 * not recognise, so a bad URL never reaches here.
 */

/**
 * How long the confirmation stays up before the patient is taken to the
 * consultation.
 *
 * The redirect is kept, because the point of the flow is to get someone into a
 * voice call, but it no longer happens instantly: an immediate
 * `location.assign` meant the success toast was raised on a document that was
 * already being torn down, so nobody ever saw it, and the only evidence a
 * booking had happened was the page changing. Long enough to read, short
 * enough that most people are not still reading when it goes.
 */
const REDIRECT_SECONDS = 20;

/**
 * A completed booking.
 *
 * The URL is the sealed spectate token, not a record: `spectateUrl` used to
 * carry the patient's name, email, date of birth, and symptoms in a query
 * parameter, and it is now an opaque ciphertext that the server can open and
 * nobody else can. That is what makes it safe to put on the page and behind a
 * disclosure rather than in a console.
 */
interface Booking {
  url: string;
  appointmentId: string;
}

const LABEL =
  "block text-xs font-semibold text-ink-soft uppercase tracking-wider mb-1.5";
const CONTROL =
  "w-full bg-surface-sunken border border-rule rounded-xl px-4 py-3 text-sm text-ink placeholder-slate-400 focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors";
/** Same control, marked as rejected. A border colour change alone would not be
 *  enough: it is a hue shift, and hue is not the only thing a screen reader or
 *  a monochrome display has to go on. `aria-invalid` and a message carry the
 *  state; the colour is a second signal, not the only one. */
const CONTROL_INVALID =
  "border-danger-rule border-2 focus:border-danger focus:ring-danger/20 bg-surface";
const ERROR_TEXT = "mt-1.5 text-xs font-medium text-danger";
const ERROR_BORDER = "border-danger-rule";

/**
 * One card per person, as the form's own state.
 *
 * An index and nothing else, because the index is the identity: it is what the
 * input is named after, what a server error path addresses, and what the DOM id
 * is derived from. A card holds no field values, so removing the middle one
 * cannot leave someone else's text attached to the wrong name, and the browser's
 * own inputs keep the values keyed by the name they were rendered with.
 */
interface HouseholdCard {
  key: number;
}

/**
 * The next card's index.
 *
 * Monotonic and never reused, so removing a person in the middle leaves a gap in
 * the rendered names while the fields on either side of it keep the names they
 * were given. Reusing the index would move a validation message that is still
 * showing onto a different person's card.
 */
let nextCardKey = 0;

function freshCard(): HouseholdCard {
  nextCardKey += 1;
  return { key: nextCardKey };
}

export default function IntakeForm({
  slug,
  language,
}: {
  slug: LiveLanguageSlug;
  language: LiveLanguage;
}) {
  const t = language.messages;

  const [errors, setErrors] = useState<FieldErrors>({});
  const [unattached, setUnattached] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [booked, setBooked] = useState<Booking | null>(null);
  const [staying, setStaying] = useState(false);
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);
  // How many other people are in this booking, and a stable identity for each.
  // The array position is the index a card is named after; `key` is what React
  // reconciles on, and the two must not be the same number.
  const [cards, setCards] = useState<HouseholdCard[]>([]);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const confirmationRef = useRef<HTMLHeadingElement | null>(null);
  // The gate refuses a second submission synchronously, which a state flag
  // cannot: two clicks in one frame both read `pending === false`. The state
  // alongside it is what renders the disabled button.
  const gate = useRef(createSubmitGate());

  const people = peopleCount(cards.length);
  const roomLeft = nextHouseholdSize(cards.length);

  const showError = (field: IntakeFieldName) => Boolean(errors[field]);
  const errorFor = (index: number, field: DependentFieldName) =>
    errors[dependentFieldName(index, field)];

  const addPerson = () => {
    if (nextHouseholdSize(cards.length) === null) return;

    setCards((current) => [...current, freshCard()]);
    setErrors((current) => {
      const cleared: FieldErrors = { ...current };
      // A stale message on a brand new card would be about a person who is not
      // there yet, and a household-level error about the count is now stale in
      // the other direction.
      delete cleared.dependents;
      return cleared;
    });
  };

  const removePerson = (index: number) => {
    setCards((current) => current.filter((_, at) => at !== index));
    setErrors((current) => {
      const cleared: FieldErrors = { ...current };
      // Every message that named the card that just went, not only the ones
      // still rendered at their old positions -- and the ones that moved up a
      // slot, which are re-addressed by the cards that are still there. Leaving
      // the removed card's errors behind puts a date-of-birth message under
      // whichever person shifted up into the gap.
      for (const field of DEPENDENT_FIELDS) {
        delete cleared[dependentFieldName(index, field)];
      }
      return cleared;
    });
  };

  /**
   * The countdown to the consultation.
   *
   * This schedules the timer and nothing else. `staying` is in the dependency
   * list so that choosing to stay tears the timer down through the same
   * cleanup, rather than clearing it in a second place that can be forgotten.
   * The counter is not reset here: setting state in an effect body is a
   * cascading render, and the counter starts where it should in the handler
   * that opened the confirmation, where the new value is known.
   */
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

  // The form is replaced by the confirmation, so focus would otherwise be
  // dropped onto the body and a keyboard or screen reader user would be
  // returned to the top of the document with no announcement.
  useEffect(() => {
    if (booked) confirmationRef.current?.focus();
  }, [booked]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!gate.current.begin()) return;

    setPending(true);

    try {
      const formData = new FormData(e.currentTarget);
      formData.append("language", slug);
      const result = await submitIntakeForm(formData);

      // The previous version showed a success toast unconditionally and then
      // redirected only if a spectateUrl happened to be present, so a rejected
      // submission looked identical to a booking until the page silently did
      // nothing.
      if (!result.ok) {
        // A partial success is not a rejection. The appointment was stored and
        // only the confirmation email failed, so the patient still needs the
        // link to reach it. Showing only the warning would strand someone
        // holding a real booking, and telling them it failed would invite a
        // resubmission that books twice.
        if (result.spectateUrl && result.appointmentId) {
          clientLog("warn", "intake.confirmation_undelivered", {
            language: slug,
          });
          setErrors({});
          setUnattached([result.error]);
          toast.error(t.submitFailed);
          setBooked({
            url: result.spectateUrl,
            appointmentId: result.appointmentId,
          });
          setRemaining(REDIRECT_SECONDS);
          setStaying(false);
          return;
        }

        const collected = collectIssues(result.issues);
        setErrors(collected.byField);
        setUnattached(
          result.issues.length > 0 ? collected.unattached : [result.error],
        );
        clientLog("warn", "intake.submit_rejected", {
          language: slug,
          issueCount: result.issues.length,
        });
        toast.error(t.submitFailed);
        // The toast is transient and disappears. The summary does not, and it
        // is where the per-field detail is, so focus moves there rather than
        // leaving a patient to hunt for what changed.
        summaryRef.current?.focus();
        return;
      }

      setErrors({});
      setUnattached([]);
      clientLog("info", "intake.submit_accepted", { language: slug });
      toast.success(t.toastProcessing);
      // Show what happened, then go there. `setBooked` replaces the form with
      // the confirmation; the effect above does the navigating, on a timer the
      // patient can cancel.
      setBooked({ url: result.spectateUrl, appointmentId: result.appointmentId });
      setRemaining(REDIRECT_SECONDS);
      setStaying(false);
    } catch (error) {
      // A server action can throw before it returns its union: a dropped
      // connection, a platform error, a serialization failure. Previously that
      // was an unhandled rejection and a form that looked ready to submit
      // again while nothing had been sent.
      clientLog("error", "intake.submit_failed", {
        language: slug,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      setErrors({});
      setUnattached([t.submitFailed]);
      toast.error(t.submitFailed);
    } finally {
      gate.current.end();
      setPending(false);
    }
  };

  return (    // `main` with an id, because the skip link in the root layout points here
    // and because this is the page's only content: one form, on a page whose
    // whole interactive surface is that form.
    <main
      id="main"
      // The document's language, declared on the part of the document that is
      // in it. A screen reader uses this to pick a voice and, for `dir`, to
      // read punctuation and numbers the right way round; without it this form
      // is announced in English with Spanish text in it.
      lang={htmlLang(language)}
      dir={language.direction}
      className="min-h-screen bg-paper text-ink flex flex-col items-center justify-center p-6"
    >
      <div className="w-full max-w-xl my-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs text-accent hover:text-accent-strong font-semibold transition-colors tap-target"
          >
            {/* The arrow points back the way the page reads. */}
            <span className="flow-arrow" aria-hidden="true">
              &larr;
            </span>{" "}
            {t.back}
          </Link>
          <LowBandwidthToggle label={t.lowBandwidth} />
        </div>

        <div className="bg-surface border border-rule rounded-3xl p-8 shadow-xl">
          {!booked && (
            <div className="mb-8 text-center">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink mb-2">
                {t.title}
              </h1>
              <p className="text-sm text-ink-muted">{t.subtitle}</p>
            </div>
          )}

          {/*
            The error summary. `role="alert"` so it is announced when it
            appears, and focusable so it can be moved to: a summary a screen
            reader user has to go looking for is not a summary, it is a
            decoration. Each entry links to the control it is about.
          */}
          {!booked && (hasFieldErrors(errors) || unattached.length > 0) && (
            <div
              ref={summaryRef}
              tabIndex={-1}
              role="alert"
              className="mb-6 rounded-2xl border-2 border-danger-rule bg-danger-soft p-4 text-start"
            >
              <h2 className="text-sm font-bold text-danger-ink">
                {t.fixErrors}
              </h2>
              {hasFieldErrors(errors) && (
                <ul className="mt-2 space-y-1 text-sm text-danger-ink list-disc ps-5">
                  {summaryEntries(errors, t).map((entry) => (
                    <li key={entry.field}>
                      <a
                        href={entry.href}
                        className="underline font-semibold hover:text-danger-ink"
                      >
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

          {!booked && (
          <form
            onSubmit={handleSubmit}
            aria-busy={pending}
            className="space-y-5"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="firstName" className={LABEL}>
                  {t.firstName}
                </label>
                <input
                  type="text"
                  id="firstName"
                  name="firstName"
                  required
                  autoComplete="given-name"
                  dir="auto"
                  placeholder={t.firstNamePlaceholder}
                  aria-invalid={showError("firstName") || undefined}
                  aria-describedby={showError("firstName") ? errorId("firstName") : undefined}
                  className={`${CONTROL} ${showError("firstName") ? CONTROL_INVALID : ""}`}
                />
                {errors.firstName && (
                  <p id={errorId("firstName")} className={ERROR_TEXT}>
                    {errors.firstName}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="lastName" className={LABEL}>
                  {t.lastName}
                </label>
                <input
                  type="text"
                  id="lastName"
                  name="lastName"
                  required
                  autoComplete="family-name"
                  dir="auto"
                  placeholder={t.lastNamePlaceholder}
                  aria-invalid={showError("lastName") || undefined}
                  aria-describedby={showError("lastName") ? errorId("lastName") : undefined}
                  className={`${CONTROL} ${showError("lastName") ? CONTROL_INVALID : ""}`}
                />
                {errors.lastName && (
                  <p id={errorId("lastName")} className={ERROR_TEXT}>
                    {errors.lastName}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="email" className={LABEL}>
                {t.email}
              </label>
              <input
                type="email"
                id="email"
                name="email"
                required
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                placeholder={t.emailPlaceholder}
                aria-invalid={showError("email") || undefined}
                aria-describedby={showError("email") ? errorId("email") : undefined}
                className={`${CONTROL} ${showError("email") ? CONTROL_INVALID : ""}`}
              />
              {errors.email && (
                <p id={errorId("email")} className={ERROR_TEXT}>
                  {errors.email}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="dob" className={LABEL}>
                  {t.dob}
                </label>
                <input
                  type="date"
                  id="dob"
                  name="dob"
                  required
                  autoComplete="bday"
                  aria-invalid={showError("dob") || undefined}
                  aria-describedby={showError("dob") ? errorId("dob") : undefined}
                  className={`${CONTROL} ${showError("dob") ? CONTROL_INVALID : ""}`}
                />
                {errors.dob && (
                  <p id={errorId("dob")} className={ERROR_TEXT}>
                    {errors.dob}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="phone" className={LABEL}>
                  {t.phone}
                </label>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  required
                  autoComplete="tel"
                  inputMode="tel"
                  dir="ltr"
                  placeholder={t.phonePlaceholder}
                  aria-invalid={showError("phone") || undefined}
                  aria-describedby={showError("phone") ? errorId("phone") : undefined}
                  className={`${CONTROL} ${showError("phone") ? CONTROL_INVALID : ""}`}
                />
                {errors.phone && (
                  <p id={errorId("phone")} className={ERROR_TEXT}>
                    {errors.phone}
                  </p>
                )}
              </div>
            </div>

            {/*
              A radio group, so it is a fieldset with a legend. It used to be a
              bare label and a div: a screen reader announced two unrelated
              checkboxes with no question attached, and there was nothing to
              hang the group's error message on.
            */}
            <fieldset
              aria-invalid={showError("insurance") || undefined}
              aria-describedby={showError("insurance") ? errorId("insurance") : undefined}
              className={`rounded-2xl border ${
                showError("insurance") ? ERROR_BORDER : "border-transparent"
              }`}
            >
              <legend className="text-xs font-semibold text-ink-soft uppercase tracking-wider mb-2 px-0">
                {t.insurance}
              </legend>
              <div className="flex flex-wrap gap-6 bg-surface-sunken border border-rule rounded-xl p-3.5">
                <label className="flex items-center cursor-pointer text-sm font-medium text-ink">
                  <input
                    type="radio"
                    id="insurance"
                    name="insurance"
                    value="yes"
                    required
                    className="me-2 accent-accent w-4 h-4"
                  />
                  {t.yes}
                </label>
                <label className="flex items-center cursor-pointer text-sm font-medium text-ink">
                  <input
                    type="radio"
                    name="insurance"
                    value="no"
                    className="me-2 accent-accent w-4 h-4"
                  />
                  {t.no}
                </label>
              </div>
              {errors.insurance && (
                <p id={errorId("insurance")} className={ERROR_TEXT}>
                  {errors.insurance}
                </p>
              )}
            </fieldset>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="appointmentDateTime" className={LABEL}>
                  {t.appointmentDateTime}
                </label>
                <input
                  type="datetime-local"
                  id="appointmentDateTime"
                  name="appointmentDateTime"
                  required
                  aria-invalid={showError("appointmentDateTime") || undefined}
                  aria-describedby={
                    showError("appointmentDateTime")
                      ? errorId("appointmentDateTime")
                      : undefined
                  }
                  className={`${CONTROL} ${showError("appointmentDateTime") ? CONTROL_INVALID : ""}`}
                />
                {errors.appointmentDateTime && (
                  <p id={errorId("appointmentDateTime")} className={ERROR_TEXT}>
                    {errors.appointmentDateTime}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="medical_department" className={LABEL}>
                  {t.whoToVisit}
                </label>
                <select
                  id="medical_department"
                  name="medical_department"
                  required
                  aria-invalid={showError("medical_department") || undefined}
                  aria-describedby={
                    showError("medical_department")
                      ? errorId("medical_department")
                      : undefined
                  }
                  className={`${CONTROL} ${showError("medical_department") ? CONTROL_INVALID : ""}`}
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
                placeholder={t.additionalInfoPlaceholder}
                aria-invalid={showError("additionalInfo") || undefined}
                aria-describedby={
                  showError("additionalInfo") ? errorId("additionalInfo") : undefined
                }
                className={`${CONTROL} resize-none ${showError("additionalInfo") ? CONTROL_INVALID : ""}`}
              />
              {errors.additionalInfo && (
                <p id={errorId("additionalInfo")} className={ERROR_TEXT}>
                  {errors.additionalInfo}
                </p>
              )}
            </div>

            {/*
              The household section. Last, after the account holder's own
              questions, because it is the part most people do not need: a
              patient booking for themselves should never have to scroll past
              four other people to find the button.

              A fieldset per person, so a screen reader announces "Person 2,
              child" as a group rather than four unlabelled inputs in a row.
            */}
            <section
              id="dependents"
              aria-describedby={showError("dependents") ? errorId("dependents") : undefined}
              className={`rounded-2xl border border-rule bg-surface-sunken p-4 sm:p-5 ${
                showError("dependents") ? ERROR_BORDER : ""
              }`}
            >
              <h2 className="text-sm font-bold text-ink">{t.household}</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                {t.householdIntro}
              </p>

              {showError("dependents") && (
                <p id={errorId("dependents")} className={ERROR_TEXT}>
                  {errors.dependents}
                </p>
              )}

              {cards.length > 0 && (
                <p className="mt-3 text-xs font-medium text-ink-soft">
                  {formatMessage(t.householdLimit, { count: MAX_HOUSEHOLD_SIZE })}
                </p>
              )}

              <div className="mt-4 space-y-4">
                {cards.map((card, index) => (
                  <DependentCard
                    key={card.key}
                    index={index}
                    onRemove={() => removePerson(index)}
                    messages={t}
                    errorFor={errorFor}
                  />
                ))}
              </div>

              {/*
                Hidden once the cap is reached rather than disabled. A disabled
                button with no explanation is a dead control; this one is simply
                not there, and the limit is stated in words above so the absence
                reads as a decision rather than a bug.
              */}
              {roomLeft !== null && (
                <button
                  type="button"
                  onClick={addPerson}
                  className="mt-4 w-full inline-flex items-center justify-center gap-2 border border-accent text-accent hover:bg-accent-soft font-semibold py-3 rounded-xl transition-colors cursor-pointer text-sm tracking-wide tap-target"
                >
                  {t.addPerson}
                </button>
              )}
            </section>

            {/*
              `disabled` rather than a click handler that ignores the second
              click: a disabled button is out of the tab order and out of the
              accessibility tree's reachable set, so a screen reader user is
              told the form is busy by the control itself. The status region
              below carries the same information in words, because a disabled
              button is not always announced.
            */}
            <button
              type="submit"
              disabled={pending}
              aria-disabled={pending}
              className="w-full bg-accent hover:bg-accent-strong disabled:bg-accent/60 disabled:shadow-none text-white font-semibold py-4 rounded-xl shadow-md transition-colors cursor-pointer disabled:cursor-progress text-center text-sm tracking-wide inline-flex items-center justify-center gap-2.5"
            >
              {pending && (
                // `motion-reduce:animate-none` so the spinner stops for anyone
                // who has asked the operating system for less motion.
                <svg
                  className="animate-spin motion-reduce:animate-none h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-30"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-90"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              {pending ? t.submitting : t.submit}
            </button>
            <p role="status" aria-live="polite" className="sr-only">
              {pending ? t.submitting : ""}
            </p>
          </form>
          )}

          {/*
            The confirmation replaces the form, and the redirect that used to
            happen instantly now happens on a timer this can cancel. See
            BookingConfirmation for the reasoning.
          */}
          {booked && (
            <BookingConfirmation
              url={booked.url}
              appointmentId={booked.appointmentId}
              people={people}
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
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * One other person in the booking.
 *
 * Its own component, so the account holder's form does not grow a second copy of
 * every control and so this markup can be rendered to a string in a test -- which
 * is the only way to check that a card's inputs are named the way the server's
 * validation errors address them, and that two cards never share an id.
 *
 * It takes no state. Every input is uncontrolled and identified by its `name`,
 * which is what lets a card be removed from the middle of a household without
 * moving one person's text under another person's name: React reconciles the DOM
 * node on `key`, and only the name it is submitted under changes.
 *
 * `errorFor` returns the message the server sent for one field on this card, or
 * undefined. It is passed in rather than the whole error map so that this
 * component cannot reach a field that is not on its own card, and it returns the
 * text rather than a boolean because a control that is marked invalid with no
 * message beside it tells a patient nothing about what to fix.
 */
export function DependentCard({
  index,
  onRemove,
  messages: t,
  errorFor,
}: {
  index: number;
  onRemove: () => void;
  messages: Messages;
  errorFor: (index: number, field: DependentFieldName) => string | undefined;
}) {
  // The submitted name, and the DOM id the error summary links to. The two are
  // the same string with the dots turned into dashes; see `fieldId` in
  // ./formIssues, which is what the summary uses on the other side of that.
  const name = (field: DependentFieldName) => dependentFieldName(index, field);
  const id = (field: DependentFieldName) => fieldId(name(field));

  const control = (field: DependentFieldName) => {
    const message = errorFor(index, field);
    return {
      message,
      "aria-invalid": message ? (true as const) : undefined,
      "aria-describedby": message ? errorId(name(field)) : undefined,
      className: `${CONTROL} ${message ? CONTROL_INVALID : ""}`,
    };
  };

  return (
    <fieldset className="rounded-xl border border-rule bg-surface p-4">
      <legend className="px-1 text-xs font-bold uppercase tracking-wider text-ink-soft">
        {formatMessage(t.personHeading, { number: index + 2 })}
      </legend>

      {/*
        A real button rather than a checkbox or a swipe. Removing a person
        discards what they typed, so it has to be a control that can be reached,
        focused, and announced -- and it is a button so that a form submission
        never picks it up as a value.
      */}
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          className="text-xs font-semibold text-danger hover:underline tap-target"
        >
          {t.removePerson}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={id("firstName")} className={LABEL}>
            {t.firstName}
          </label>
          <input type="text" id={id("firstName")} name={name("firstName")} required dir="auto" {...control("firstName")} />
          {errorFor(index, "firstName") && (
            <p id={errorId(name("firstName"))} className={ERROR_TEXT}>
              {errorFor(index, "firstName")}
            </p>
          )}
        </div>

        {/*
          Not `required`, and labelled as optional. A child is usually recorded
          under the account holder's surname, which is already on the form, and
          the server accepts an absent one for the same reason.
        */}
        <div>
          <label htmlFor={id("lastName")} className={LABEL}>
            {t.dependentLastNameOptional}
          </label>
          <input type="text" id={id("lastName")} name={name("lastName")} dir="auto" {...control("lastName")} />
          {errorFor(index, "lastName") && (
            <p id={errorId(name("lastName"))} className={ERROR_TEXT}>
              {errorFor(index, "lastName")}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={id("dob")} className={LABEL}>
            {t.dob}
          </label>
          <input type="date" id={id("dob")} name={name("dob")} required {...control("dob")} />
          {errorFor(index, "dob") && (
            <p id={errorId(name("dob"))} className={ERROR_TEXT}>
              {errorFor(index, "dob")}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={id("relationship")} className={LABEL}>
            {t.dependentRelationship}
          </label>
          <select id={id("relationship")} name={name("relationship")} required {...control("relationship")}>
            <option value="">{t.selectRelationship}</option>
            {RELATIONSHIP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t[option.messageKey]}
              </option>
            ))}
          </select>
          {errorFor(index, "relationship") && (
            <p id={errorId(name("relationship"))} className={ERROR_TEXT}>
              {errorFor(index, "relationship")}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor={id("additionalInfo")} className={LABEL}>
          {t.dependentReason}
        </label>
        <textarea id={id("additionalInfo")} name={name("additionalInfo")} rows={2} dir="auto" {...control("additionalInfo")} />
        {errorFor(index, "additionalInfo") && (
          <p id={errorId(name("additionalInfo"))} className={ERROR_TEXT}>
            {errorFor(index, "additionalInfo")}
          </p>
        )}
      </div>
    </fieldset>
  );
}
