import type {
  ClinicAppointmentRow,
  ClinicHouseholdMember,
} from "@/lib/clinic/schedule-view";

/**
 * The clinic schedule, as HTML.
 *
 * A `.ts` file assembling strings, and not a component tree, for two reasons that
 * are worth being explicit about.
 *
 * **The framework will not let a route handler render React.** Turbopack refuses
 * `react-dom/server` inside an App Route ("render or return the content directly
 * as a Server Component instead"), so a route handler that returns a page has to
 * assemble it. A page could render natively, but a page cannot return a 401 --
 * and every other gated surface in this application answers 401, and this one
 * gates a bulk read of every patient record in the building.
 *
 * **Which makes the escaping this file's job, and that is the part to read.**
 * Every value below reaches the markup through `esc()`, including the ones in
 * attributes. The names, the reason and the household notes are free text written
 * by whoever made the booking, and this page is rendered as HTML; a helper that
 * forgot one field would be an XSS with a patient's name in it. The tests in
 * ./route.test.ts feed a script tag, an attribute break-out and a closing tag
 * through every field and assert that none of them survives.
 *
 * The only string on the page that is *not* escaped is `DASHBOARD_STYLES`, which
 * is a constant in this repository and cannot be reached by a request.
 *
 * The shape is a day sheet: the time in a gutter down the left in tabular
 * figures, a hairline between patients, the reason given the most visual weight
 * in the row because it is the part a clinician has not heard yet, and a coloured
 * rule down the left edge for the one thing worth interrupting for -- a requested
 * time that has already passed.
 *
 * There is no client JavaScript. Paging is a link, because a link works from a
 * terminal, from a kiosk, from a printer and from a screen reader, and because a
 * page holding PHI should have as little executable surface as it can get away
 * with. The link is an offset and nothing else -- see ./route.ts for why the
 * shared secret is not in it.
 */

export interface ScheduleViewProps {
  clinicName: string;
  rows: ClinicAppointmentRow[];
  offset: number;
  limit: number;
  nextOffset: number | null;
  /** True when the clinic has appointments this dashboard will not show. */
  truncated: boolean;
  /**
   * The furthest this list will page, as a number the page states for itself.
   *
   * Passed in rather than imported so the page reports the bound that was
   * actually applied -- a clinician reading "stops after 200" is being told what
   * this deployment will do, not what a constant once said.
   */
  furthestOffset: number;
}

export function renderScheduleView(props: ScheduleViewProps): string {
  const { rows, offset, limit, nextOffset, truncated, clinicName, furthestOffset } = props;

  const masthead = [
    '<header class="masthead">',
    `<p class="eyebrow">${esc(clinicName)}</p>`,
    '<h1 class="title">Appointments</h1>',
    rows.length > 0 ? `<p class="standfirst">${standfirst(rows.length)}</p>` : "",
    "</header>",
  ].join("");

  // Prose is written across lines in a template literal because HTML collapses the
  // newline into a space, and because a string split across array elements loses
  // the space between them -- which is how "forwardit" happens.
  const notice = truncated
    ? [
        '<p class="notice" role="status">',
        `There are more bookings than this page shows.
         Pages come in the order the requests were made, and each page is ordered by the
         time the patient asked for. The list stops after ${esc(furthestOffset)} bookings.`,
        "</p>",
      ].join("")
    : "";

  const list =
    rows.length === 0
      ? emptyState()
      : [`<ol class="list">`, ...rows.map(appointmentRow), "</ol>"].join("");

  return [
    '<main class="sheet">',
    masthead,
    notice,
    list,
    pager(offset, limit, nextOffset, rows.length > 0),
    footer(limit, furthestOffset),
    "</main>",
  ].join("");
}

function standfirst(rows: number): string {
  return rows === 1
    ? "One appointment is on this page, soonest first."
    : `${rows} appointments are on this page, soonest first.`;
}

function emptyState(): string {
  return [
    '<section class="empty">',
    '<h2 class="empty-title">No live appointments</h2>',
    '<p class="empty-body">',
    `Every request this clinic has is cancelled or completed.
     A booking appears here the moment a patient sends one.`,
    "</p>",
    "</section>",
  ].join("");
}

function appointmentRow(row: ClinicAppointmentRow): string {
  const { patient, requestedAtLabel } = row;

  const gutter = requestedAtLabel
    ? [
        `<span class="time">${esc(requestedAtLabel.time)}</span>`,
        `<span class="day">${esc(requestedAtLabel.date)}</span>`,
      ].join("")
    : [
        '<span class="time time-unknown">&mdash;</span>',
        '<span class="day">no time given</span>',
      ].join("");

  const facts: string[] = [
    fact("Date of birth", patient.dob),
    fact("Phone", patient.phone),
    fact("Email", patient.email),
    fact(
      "Insurance",
      patient.insurance === "unknown"
        ? "not answered"
        : patient.insurance === "yes"
          ? "yes"
          : "no",
    ),
    fact("Department", row.department),
    fact("Language", row.language === "" ? "not recorded" : row.language, {
      note:
        row.language !== "" && row.language !== "english" ? "interpreter needed" : undefined,
    }),
  ];

  const reason =
    row.reason.trim() === ""
      ? '<p class="reason-empty">The patient did not write anything about why they are coming in.</p>'
      : `<p class="reason-text">${esc(row.reason)}</p>`;

  const household =
    row.household.length === 0
      ? ""
      : [
          '<div class="household">',
          '<span class="label">Coming with them</span>',
          '<ul class="household-list">',
          ...row.household.map(householdMember),
          "</ul>",
          "</div>",
        ].join("");

  const changed =
    row.updatedAt !== row.bookedAt ? ` &middot; last change ${esc(row.updatedAt.slice(0, 10))}` : "";

  return [
    `<li class="row" data-appointment="${esc(row.id)}" data-status="${esc(row.status)}" data-passed="${row.timeHasPassed ? "yes" : "no"}">`,
    '<div class="gutter">',
    gutter,
    row.timeHasPassed ? '<span class="passed">requested time has passed</span>' : "",
    "</div>",
    '<div class="body">',
    '<div class="head">',
    `<h2 class="name">${esc(patient.firstName)} ${esc(patient.lastName)}</h2>`,
    `<span class="pill pill-${esc(row.status)}">${esc(row.status)}</span>`,
    "</div>",
    `<dl class="facts">${facts.join("")}</dl>`,
    '<div class="reason">',
    '<span class="label">In their words</span>',
    reason,
    "</div>",
    household,
    `<p class="reference">Ref ${esc(row.id)} &middot; booked ${esc(row.bookedAt.slice(0, 10))}${changed}</p>`,
    "</div>",
    "</li>",
  ].join("");
}

function householdMember(member: ClinicHouseholdMember): string {
  const name = member.lastName ? `${member.firstName} ${member.lastName}` : member.firstName;
  const note =
    member.additionalInfo.trim() === ""
      ? ""
      : `<span class="member-note">${esc(member.additionalInfo)}</span>`;

  return [
    '<li class="member">',
    `<span class="member-name">${esc(name)}<span class="member-relation"> (${esc(member.relationship)})</span></span>`,
    `<span class="member-dob">born ${esc(member.dob)}</span>`,
    note,
    "</li>",
  ].join("");
}

function fact(label: string, value: string, options: { note?: string } = {}): string {
  const shown =
    value === "" ? '<span class="missing">not given</span>' : esc(value);
  const note = options.note ? ` <span class="fact-note">${esc(options.note)}</span>` : "";

  return [
    '<div class="fact">',
    `<dt class="fact-label">${esc(label)}</dt>`,
    `<dd class="fact-value">${shown}${note}</dd>`,
    "</div>",
  ].join("");
}

function pager(offset: number, limit: number, nextOffset: number | null, hasRows: boolean): string {
  const previous =
    offset > 0
      ? `<a class="pager-link" href="/dashboard?offset=${offset - limit}" rel="nofollow">Previous</a>`
      : '<span class="pager-link pager-disabled">Previous</span>';

  const next =
    nextOffset === null
      ? ""
      : `<a class="pager-link" href="/dashboard?offset=${nextOffset}" rel="nofollow">Next</a>`;

  const note = hasRows ? "" : '<span class="pager-note">There is nothing on this page.</span>';

  return [
    '<nav class="pager" aria-label="Pages of appointments">',
    previous,
    next,
    note,
    "</nav>",
  ].join("");
}

function footer(limit: number, furthestOffset: number): string {
  return [
    '<footer class="footer">',
    "<p>",
    `Every record on this page is protected health information.
     Do not print it, forward it, or leave it on an unattended screen.`,
    "</p>",
    `<p class="fine">At most ${esc(furthestOffset)} live bookings, ${esc(limit)} to a page. Cancelled and completed appointments are not listed.</p>`,
    "</footer>",
  ].join("");
}

/**
 * The one function every value on this page goes through.
 *
 * `string | number` rather than `string`, because the counts on this page are
 * numbers and the alternative is a `String(...)` at each of them -- and a helper
 * that takes `string` gets a number passed to it by somebody in a hurry, at
 * runtime, with no type error anywhere. Taking the union makes that a mistake
 * the compiler catches instead.
 *
 * `&` first, or the ampersands this introduces get escaped again. Both quote
 * forms, because a single-quoted attribute and an unquoted one are both things
 * somebody will write later. Nothing else is encoded: this is for HTML text and
 * attribute values, not for a URL, and there is no URL here that carries
 * anything a caller supplied -- the pager's offsets are numbers this process
 * produced.
 */
function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The stylesheet, inline.
 *
 * Inline because a route handler is not the App Router: there is no layout, no
 * metadata export and no hashed stylesheet it can link. It is a constant in the
 * repository, so no request reaches it and it carries no value from one.
 */
export const DASHBOARD_STYLES = `
:root {
  --ink: #0f172a;
  --ink-soft: #475569;
  --ink-faint: #94a3b8;
  --rule: #e2e8f0;
  --paper: #f8fafc;
  --teal: #0f766e;
  --teal-soft: #ccfbf1;
  --amber: #b45309;
  --amber-soft: #fef3c7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.sheet { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
.eyebrow {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--teal);
}
.title { margin: 0.4rem 0 0; font-size: 2rem; letter-spacing: -0.02em; font-weight: 600; }
.standfirst { margin: 0.5rem 0 0; color: var(--ink-soft); }
.notice {
  margin: 1.75rem 0 0;
  padding: 0.85rem 1rem;
  border: 1px solid #fde68a;
  border-left: 3px solid var(--amber);
  background: var(--amber-soft);
  border-radius: 0.4rem;
  color: #78350f;
  font-size: 0.875rem;
}
.list { list-style: none; margin: 2rem 0 0; padding: 0; }
.row {
  display: grid;
  grid-template-columns: 9.5rem 1fr;
  gap: 0 1.75rem;
  padding: 1.5rem 0;
  border-top: 1px solid var(--rule);
  border-left: 3px solid transparent;
  padding-left: 1rem;
  margin-left: -1rem;
}
.row[data-passed="yes"] { border-left-color: var(--amber); }
.row[data-passed="no"] { border-left-color: var(--teal-soft); }
.gutter { font-variant-numeric: tabular-nums; }
.time { display: block; font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; }
.time-unknown { color: var(--ink-faint); }
.day { display: block; font-size: 0.8125rem; color: var(--ink-soft); }
.passed {
  display: inline-block;
  margin-top: 0.5rem;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
}
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.name { margin: 0; font-size: 1.125rem; font-weight: 600; }
.pill {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--rule);
  color: var(--ink-soft);
  white-space: nowrap;
}
.pill-confirmed { border-color: #99f6e4; background: var(--teal-soft); color: var(--teal); }
.pill-scheduled { border-color: var(--rule); background: #fff; }
.facts { display: flex; flex-wrap: wrap; gap: 0.35rem 1.75rem; margin: 0.9rem 0 0; }
.fact { min-width: 9rem; }
.fact-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.fact-value { margin: 0.1rem 0 0; font-size: 0.875rem; }
.missing { color: var(--ink-faint); font-style: italic; }
.fact-note { font-size: 11px; color: var(--amber); }
.reason { margin-top: 1.25rem; }
.label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 0.25rem;
}
.reason-text {
  margin: 0;
  padding-left: 0.85rem;
  border-left: 2px solid var(--teal-soft);
  font-size: 0.9375rem;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.reason-empty { margin: 0; padding-left: 0.85rem; border-left: 2px solid var(--rule); color: var(--ink-faint); font-style: italic; }
.household { margin-top: 1.25rem; }
.household-list { list-style: none; margin: 0; padding: 0; }
.member { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; font-size: 0.875rem; padding: 0.2rem 0; }
.member-relation, .member-dob { color: var(--ink-soft); }
.member-note { flex-basis: 100%; padding-left: 0.85rem; color: var(--ink); }
.reference { margin: 1.25rem 0 0; font-size: 11px; color: var(--ink-faint); }
.empty {
  margin-top: 2rem;
  padding: 2.5rem 1.5rem;
  border: 1px dashed var(--rule);
  border-radius: 0.6rem;
  text-align: center;
  background: #fff;
}
.empty-title { margin: 0; font-size: 1.0625rem; font-weight: 600; }
.empty-body { margin: 0.5rem auto 0; max-width: 30rem; color: var(--ink-soft); }
.pager { display: flex; gap: 0.75rem; align-items: center; margin-top: 2rem; }
.pager-link {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--rule);
  border-radius: 0.4rem;
  background: #fff;
  color: var(--teal);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
}
.pager-link:hover { border-color: var(--teal); }
.pager-disabled { color: var(--ink-faint); }
.pager-note { color: var(--ink-soft); font-size: 0.875rem; }
.footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
.footer p { margin: 0; color: var(--ink-soft); font-size: 0.875rem; }
.fine { margin-top: 0.5rem !important; color: var(--ink-faint) !important; font-size: 11px !important; }
@media (max-width: 40rem) {
  .row { grid-template-columns: 1fr; gap: 0.75rem; }
  .gutter { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  .day { display: inline; }
  .passed { margin-top: 0; }
}
`;
