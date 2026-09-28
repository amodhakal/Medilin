# Medilin

## Status

**Medilin is a hackathon prototype. It is not HIPAA compliant and must not be
used with real patient data or for actual patient care.**

It has previously been described in this README and in the UI as a
"HIPAA compliant voice bridge". That claim is not accurate and has been
removed. Below is an honest account of where the controls actually stand, and of
which parts of the earlier version of this section no longer apply.

### Gaps that remain

These are real, and none of them are fixed by anything in this repository:

- **No business associate agreement** is in place with any vendor, all of which
  receive patient data (Google, Resend, ElevenLabs, Twilio, Sentry). A BAA is a
  contractual instrument, not a code change.
- **There is no patient or clinician identity.** Nothing here is an account
  system. Access to a record is a bearer token, and access to the clinician
  surfaces is one shared secret that any one holder of which sees every patient.
  The audit trail records *that* a dashboard was opened and when; it cannot
  record *who* opened it.
- **Bearer links are not revocable in the sealed-token form.** The version 1
  token is the record encrypted into the URL, so it cannot be withdrawn. Patient
  action links (#59) are revocable and single-use; the spectate and tracking
  links are not.
- **A transcript can be rewritten by the holder of a valid link.** Correcting a
  line in place is what makes streamed partials collapse and makes client retries
  idempotent, but it is a capability the link bearer has.
- **The audit chain proves the log was not edited, not that it was not
  rewritten.** There is no external head anchoring the chain, so an actor with
  write access can replace the log wholesale. Verification is linear and
  re-reads everything.
- **The Twilio media-stream bridge (#3) is not built.** Serverless cannot hold a
  WebSocket open for the length of a call, so a Twilio media stream has to be
  terminated by a long-lived service. That service is not in this repository.
  With `TWILIO_MEDIA_STREAM_URL` unset the outbound call still works and the
  clinic hears a greeting, but the conversation is not streamed into the LLM.
- **A Twilio call is not written back onto the appointment.** The agent
  negotiates a slot out loud; the patient's confirmation email carries the
  locally-negotiated time, not whatever was agreed on the call.
- **`/api/webhook` is not interoperable with a stock Twilio sender.** It
  implements HMAC-SHA256 over a JSON body, which is what the issue asked for.
  Real Twilio status callbacks are `application/x-www-form-urlencoded` with an
  HMAC-SHA1 over the URL plus sorted parameters. `/api/twilio/*` implements the
  real scheme; `/api/webhook` does not.

### Claims from earlier versions of this README that no longer apply

Each of these was true when this section was first written and is now fixed.
They are listed because a reader who saw the older README will believe otherwise.

- ~~"There is no authentication on any endpoint."~~ The service-to-service and
  clinician surfaces are gated: `/api/webhook` and `/api/audit` by
  `INTERNAL_API_SECRET`, `/api/intake-summary` and `/dashboard` by the same
  secret, `/api/cron/reminders` by `CRON_SECRET`. The patient-facing endpoints
  (`/api/intake`, `/api/voice/*`, `/api/transcript*`,
  `/api/appointment-actions`) are deliberately unauthenticated and are instead
  gated by a bearer token or a rate limit — see [Access model](#access-model).
- ~~"Appointments are held in an in-memory `Map`."~~ With `DATABASE_URL` set,
  appointments and transcripts are in Postgres. **The in-memory store remains
  the default when `DATABASE_URL` is unset**, because that configuration is
  still a working one, and a deployment that leaves it unset is still losing
  bookings on every cold start.
- ~~"Patient details are placed in the spectate page's query string."~~ PHI is
  not in a URL. A link carries either a short reference resolved server-side or
  the record sealed under `HIPAA_MASTER_KEY`.
- ~~"Application logs currently print full patient records."~~ Logging is
  deny-by-default: `src/lib/logger/redact.ts` allows named fields through and
  redacts everything else, and the tests assert that names, emails, phone
  numbers, tokens and request bodies do not appear in output.
- ~~"The clinic 'call' is simulated in-process. No phone is placed."~~ With the
  five `TWILIO_*` voice variables set, a real Twilio Programmable Voice call is
  placed. **It is simulated by default**, so a contributor with no Twilio account
  still gets a working demo.
- ~~"The audit log is in-memory, so its hash chain resets on genesis on every
  restart."~~ The chain is durable when `DATABASE_URL` is set. It is still
  in-process otherwise, and the limits above apply to the chain either way.
- Patient records are envelope-encrypted at rest: a fresh DEK per record and per
  transcript line, wrapped by `HIPAA_MASTER_KEY`, no fallback key.

## Project Description

Medilin is a proof-of-concept multilingual healthcare appointment booking
platform designed to help patients who face language barriers or time
constraints when scheduling medical appointments.

The vision is simple: a patient gives their details in their own language, by
form or by voice, and the system books them in — negotiating a time, confirming
it, and giving them a link they can use to check on it or change it.

**Current Demo Status.** This is a working prototype, not a simulation of one.
A patient submits an intake form in English, Spanish or Portuguese; the system
translates it, negotiates an appointment time that avoids clashing with existing
bookings, stores the record encrypted, and sends a confirmation in the patient's
own language with an `.ics` calendar invite attached and a link to reschedule or
cancel. The booking conversation can be observed live, replayed afterwards, and
exported as a PDF. Optionally the system places a real telephone call to the
clinic.

### How It Works

1. **Intake** — the patient fills in a form, or answers out loud on the voice
   intake page, in their chosen language. A booking may cover a whole household.
   English, Spanish and Portuguese are live. French, Mandarin, Arabic and Hebrew
   are registered but `status: "pending"`; a language goes live by adding a
   reviewed dictionary and a one-line change to `SUPPORTED_LANGUAGES` in
   `src/lib/validation/intake.ts`. Arabic and Hebrew are there to keep the
   right-to-left path exercised rather than merely theoretical.
2. **Translation** — Gemini translates the intake into English, one call per
   person, and the confirmation is translated back.
3. **Negotiation** — the requested time is moved forward in 15-minute increments
   until it is clear of the existing schedule, and the alternatives considered
   are kept for the reply.
4. **Storage** — the record is envelope-encrypted and written to Postgres. A
   short, non-guessable reference is minted for the patient-facing links.
5. **Confirmation** — the patient gets an email, and optionally an SMS or
   WhatsApp message, in their language, with an `.ics` invite and links to
   track, reschedule, or cancel.
6. **The call** — optionally, the clinic's line is dialled through Twilio. With
   no Twilio account the receptionist is simulated in-process.
7. **Reminders** — a Vercel Cron job sends reminders the morning of the
   appointment, once per appointment however many times the job runs.
8. **Follow-up** — the patient can check the appointment's status, move or
   cancel it, and read back the transcript of the call, as a page or a PDF.

### Access model

There is no account system, so access is by possession of a credential. The
table below is the whole of it.

| Surface | Gate |
|---|---|
| `/`, `/language/[slug]`, `/voice/[slug]` | none — this is the public entry point |
| `/api/intake` | rate limit per caller; no account, by design |
| `/api/voice/session`, `/api/voice/intake` | rate limit per caller; the session endpoint additionally requires a valid booking token |
| `/track/[token]`, `/spectate/[id]` | a sealed token or short reference that **is** the appointment |
| `/reschedule/[token]`, `/api/appointment-actions` | a single-use, revocable patient action link |
| `/api/transcript`, `/api/transcript/[token]/pdf` | the same token that authorises the tracking page |
| `/dashboard`, `/api/intake-summary` | `INTERNAL_API_SECRET` |
| `/api/cron/reminders` | `CRON_SECRET` |
| `/api/webhook`, `/api/audit` | `INTERNAL_API_SECRET`, plus vendor HMAC when a webhook secret is configured |

Two boundaries are load-bearing and are asserted by tests rather than by policy:

- **`/track` and `/dashboard` are different surfaces on purpose.** The tracking
  link is designed to be forwarded by accident, so it shows four fields and
  never the intake narrative. A clinician needs the date of birth, the contact
  details and the patient's own account of why they are here, so the dashboard
  shows those. The two allowlists are asserted to differ in both directions.
- **The dashboard's shared secret is a stopgap, and the audit trail says so.**
  The actor recorded is a role, not a person. A real deployment needs clinician
  accounts.

## Tech Stack

- **Frontend:** Next.js 16, React 19, Tailwind CSS v4
- **AI Voice:** ElevenLabs (agent ids, signed conversation URLs, STT/TTS)
- **AI Language Model:** Google Gemini
- **Telephony and messaging:** Twilio (Programmable Voice, SMS, WhatsApp)
- **Email:** Resend
- **Storage:** Postgres over HTTP, in-memory fallback
- **Error monitoring:** Sentry, off unless `SENTRY_DSN` is set
- **Deployment:** Vercel, with Vercel Cron for reminders
- **Toolchain:** Bun

## Setup Instructions

1. **Clone the repository**
```bash
   git clone https://github.com/amodhakal/Medilin.git
   cd Medilin
```

2. **Install dependencies**

   This project uses [Bun](https://bun.sh) and commits a single `bun.lock`.
```bash
   bun install
```

3. **Configure environment variables**
```bash
   cp .env.example .env
```

   `.env.example` is the full list and is written against the schema in
   `src/lib/env.ts`, which is the source of truth. These **six** are required
   and the server refuses to start without them:

   - `GEMINI_KEY` — Google Gemini API key, for intake translation
   - `RESEND_KEY` — Resend API key, for confirmation email
   - `HIPAA_MASTER_KEY` — 32-byte hex key for encrypting patient data at rest.
     Generate with `openssl rand -hex 32`. There is no fallback: if this is
     unset, encryption throws rather than protecting records with a key that
     lives in the source tree.
   - `ELEVENLABS_AGENT_PATIENT_ID` — conversational AI agent for the patient
   - `ELEVENLABS_AGENT_RECEPTIONIST_ID` — conversational AI agent for reception
   - `INTERNAL_API_SECRET` — shared secret for this app's internal calls to the
     webhook, audit, dashboard and intake-summary endpoints (32+ characters,
     `openssl rand -hex 32`)

   Everything else is optional and each variable gates exactly one feature:

   | Variable | Gates |
   |---|---|
   | `DATABASE_URL` | Durable appointments, transcripts and audit log. **The single most important one to set for a real deployment** — without it the app silently uses per-instance memory and loses bookings on every cold start. Must be an `http(s)` Postgres HTTP endpoint (what Neon and the other serverless providers issue), not a `postgres://` socket URL. |
   | `ELEVENLABS_API_KEY` | Server-minted signed conversation URLs, voice-first intake, and speech synthesis. Without it the agent ids never leave the server and the voice pages offer the form instead. |
   | `ELEVENLABS_TTS_VOICE_ID` | Which voice reads intake details back |
   | `CRON_SECRET` | The reminder cron route |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS and WhatsApp confirmations. All three or none; a partial set disables messaging rather than half-configuring it. |
   | `TWILIO_CLINIC_NUMBER`, `TWILIO_CALLBACK_BASE_URL` | The real outbound call to the clinic, together with the three above — all five or nothing. |
   | `TWILIO_MEDIA_STREAM_URL` | Terminating a Twilio media stream. Must be a `wss://` URL on a long-lived service, not this serverless app. Unset is a working configuration: the call places, the clinic hears a greeting, nothing is streamed. |
   | `TWILIO_WEBHOOK_SECRET`, `ELEVENLABS_WEBHOOK_SECRET` | Vendor signature verification on `/api/webhook`, consulted only when that vendor's header is present |
   | `SENTRY_DSN` | Error monitoring. Without it the Sentry SDK is never loaded and nothing is sent anywhere. |
   | `CLINIC_NAME`, `EMAIL_FROM` | Clinic identity and sender; both have defaults |

4. **Run the development server**
```bash
   bun run dev
```

5. **Open in browser**
   Visit http://localhost:3000

> The server validates its environment on start (see `src/instrumentation.ts`)
> and refuses to boot with every missing variable listed at once. If it does
> not come up, check `.env` against `.env.example`.

### Verifying the controls

```bash
bun run verify:hipaa   # fail-closed key handling, and audit chain integrity
bun test               # the PHI-redaction tests are part of the suite
```

`verify:hipaa` checks that encryption refuses to run without a master key and
refuses a malformed one, that the audit hash chain survives a database round
trip, and that the closed sets of actions and reasons cannot be widened at the
call site. The redaction tests assert against serialised wire payloads, not
against log output: patient-shaped values must not appear in what is written to
stdout or sent to Sentry.

### Resend sender limitation

Confirmation email is sent through Resend. On the free tier Resend only delivers
to the address on the account itself, so a confirmation addressed to a patient
will not arrive until a sending domain is verified. `EMAIL_FROM` defaults to
`onboarding@resend.dev`, which has the same restriction. This is a Resend
account limitation, not a bug in the app.

## How to Demo

The form path needs no credentials beyond the six required ones.

1. Fill out and submit the intake form in your preferred language. Add a
   dependent to book for a household.
2. The confirmation screen shows the booking reference and a link to join the
   live call, and redirects to the spectate session after a few seconds.
3. On the spectate page, use the **Copy link** button in the "This session's
   link" section. No console inspection is needed — the link is in the page,
   both here and on the confirmation screen.
4. Click **Start the call** to hear the booking call, and **End call** when the
   agents agree.
5. Check your email for the confirmation in your language, with the `.ics`
   invite attached.

From there, using the links in that email:

6. The **tracking link** shows the appointment's current status.
7. The **reschedule or cancel link** moves or cancels it.
8. The **transcript** can be read back on a page or downloaded as a PDF.

With `DATABASE_URL` set, the clinician surfaces work too:

9. `curl -H "x-internal-secret: $INTERNAL_API_SECRET" localhost:3000/dashboard`
   lists the clinic's appointments, one page at a time. It is a route handler
   rather than a page because a page cannot carry a header without putting the
   secret in a URL, and a secret in a URL is in every access log on the path.

The voice path and the real call both need accounts:

10. `/voice` offers voice-first intake, gated on `ELEVENLABS_API_KEY`.
11. With the five `TWILIO_*` voice variables set, a booking places a real call
    to `TWILIO_CLINIC_NUMBER`. Set a spend limit in the Twilio console first.

> Treat a session link like a password: anyone who opens it can see the
> appointment behind the call, and — since a link bearer can correct the
> transcript — edit its record of the call. Only share it with whoever is
> watching the demo with you.
>
> For what happens between form submit and confirmation email, see
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project Structure
```
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Landing page, language picker
│   │   ├── language/[slug]/         # Localized intake form (form + confirmation)
│   │   ├── voice/[slug]/            # Voice-first intake
│   │   ├── spectate/[id]/           # Live session viewer (server wrapper + client)
│   │   ├── track/[token]/           # Public appointment status (sealed-token link)
│   │   ├── reschedule/[token]/      # Patient reschedule / cancel
│   │   ├── dashboard/               # Clinician list. A route handler, not a page
│   │   ├── api/
│   │   │   ├── intake/              # Booking submission (rate limited)
│   │   │   ├── appointments/        # Alias of the same handler
│   │   │   ├── appointment-actions/ # Spend a patient action link
│   │   │   ├── transcript/          # Append, replay, and PDF export
│   │   │   ├── intake-summary/      # Clinician triage summary (internal secret)
│   │   │   ├── voice/               # Session URL, STT, TTS
│   │   │   ├── twilio/voice/        # TwiML answer + status callback
│   │   │   ├── cron/reminders/      # Vercel Cron reminder pass
│   │   │   ├── webhook/             # Internal dispatcher + vendor HMAC
│   │   │   ├── audit/               # Audit log read/write
│   │   │   ├── health/              # Health check
│   │   │   ├── _lib/                # The booking pipeline, shared by both routes
│   │   │   └── instrumentation.ts   # Boot-time environment validation
│   │   ├── actions.ts               # Server action for the form
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/                  # Spectate UI: cards, transcript, controls
│   ├── config/                      # Non-secret application configuration
│   ├── hooks/
│   │   └── useAgentRelay.ts         # The relay state machine
│   ├── i18n/                        # Message sets, language registry, RTL
│   ├── lib/
│   │   ├── env.ts                   # Environment schema (source of truth)
│   │   ├── storage.ts               # Postgres-over-HTTP client
│   │   ├── appointments/            # Store facade, memory + Postgres, transcripts
│   │   ├── audit/                   # Hash-chained trail, durable or in-process
│   │   ├── encryption.ts            # Envelope encryption
│   │   ├── phi-token.ts             # Sealed tokens and short references
│   │   ├── action-token.ts          # Revocable, single-use patient links
│   │   ├── logger/                  # Deny-by-default redaction, Sentry bridge
│   │   ├── validation/              # Intake schema
│   │   ├── llm/                     # Gemini client, prompts, retry, household
│   │   ├── voice/                   # Signed conversation URLs, STT, TTS
│   │   ├── twilio/                  # Messaging and voice clients, channels
│   │   ├── webhook/                 # Signature verification, event ingestion
│   │   ├── transcript/              # Replay and PDF rendering
│   │   ├── clinic/                  # Clinician projection for the dashboard
│   │   ├── rate-limit/              # Per-caller limiter
│   │   ├── auth/                    # Internal shared secret
│   │   ├── reminders.ts             # Reminder selection and claiming
│   │   ├── pdf.ts                   # Minimal PDF writer
│   │   ├── gemini.ts
│   │   ├── translateToEnglish.ts
│   │   └── translateFromEnglish.ts
├── docs/
│   └── ARCHITECTURE.md              # Pipeline, tokens, relay, PHI boundaries
├── scripts/
│   └── verify-hipaa.ts              # Encryption + audit chain checks
├── vercel.json                      # Cron schedule
├── public/
├── package.json
├── next.config.ts
├── postcss.config.mjs               # Tailwind v4 is configured here
└── tsconfig.json
```

## The Problem We're Solving

Millions of people struggle to book medical appointments due to:

- Language barriers in healthcare systems
- Time constraints (can't call during business hours)
- Phone anxiety or difficulty navigating automated systems
- Lack of internet access to online booking portals

Medilin removes these barriers by having the booking handled on the patient's
behalf, in their own language, at any hour.
