# Medilin

## Status

**Medilin is a hackathon prototype. It is not HIPAA compliant and must not be
used with real patient data or for actual patient care.**

It has previously been described in this README and in the UI as a
"HIPAA compliant voice bridge". That claim is not accurate and has been
removed. Concretely, as of this commit:

- There is no authentication on any endpoint, including the intake API, the
  appointment API, the audit log, and the email webhook.
- Appointments are held in an in-memory `Map`, so they are lost on redeploy and
  are not shared between serverless instances.
- Patient details are placed in the spectate page's query string, which puts
  them in browser history and in any access log that records the URL.
- Application logs currently print full patient records.
- No business associate agreement is in place with any vendor, all of which
  receive patient data (Google, Resend, ElevenLabs).
- The clinic "call" is simulated in-process. No phone is placed.
- The encryption and audit-log modules exist and are verified, but the audit
  log is in-memory, so its hash chain resets to genesis on every restart and
  provides no durable tamper evidence.

## Project Description

Medilin is a proof-of-concept multilingual healthcare appointment booking platform designed to help patients who face language barriers or time constraints when scheduling medical appointments. 

The vision is simple: patients fill out an intake form in their native language, and an AI agent calls the clinic to book an appointment on their behalf. The patient receives a confirmation email, so no phone calls, no language barriers, no hassle.

**Current Demo Status:** This hackathon prototype demonstrates the core AI voice negotiation technology. When a patient submits an intake form, the system simulates a hospital booking response with a negotiated appointment time (different from the requested time) and sends a confirmation email. The spectate URL allows optional observation of the AI agent conversation.

### How It Works

1. **Patient Intake**: Users fill out a healthcare intake form in their preferred language
2. **Simulated Booking**: The system fabricates a hospital response with a negotiated appointment time
3. **Confirmation**: The patient receives a confirmation email with appointment details in their chosen language
4. **Optional Observation**: Users can visit the spectate URL to observe the simulated booking conversation

### Production Vision

In a production deployment, the AI agent would:
- Actually call the healthcare provider's scheduling line
- Handle real availability checks and calendar integration
- Manage conflicts and rescheduling
- Integrate with clinic EMR/scheduling systems
- Satisfy HIPAA obligations, which requires considerably more than the
  encryption and audit logging implemented here

## Tech Stack

- **Frontend:** Next.js, React, Tailwind CSS
- **AI Voice:** ElevenLabs
- **AI Language Model:** Google Gemini
- **Email:** Resend
- **Deployment:** Vercel

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

   `.env.example` is the full list; these five are **required** and the server
   refuses to start without them:
   - `GEMINI_KEY` - Google Gemini API key, for intake translation
   - `RESEND_KEY` - Resend API key, for confirmation email
   - `HIPAA_MASTER_KEY` - 32-byte hex key for encrypting patient data at rest.
     Generate with `openssl rand -hex 32`. There is no fallback: if this is
     unset, encryption throws rather than protecting records with a key that
     lives in the source tree.
   - `ELEVENLABS_AGENT_PATIENT_ID` - Conversational AI agent for the patient
   - `ELEVENLABS_AGENT_RECEPTIONIST_ID` - Conversational AI agent for reception

   `ELEVENLABS_API_KEY` is listed in `.env.example` but is not yet read by any
   code. The rest of the optional variables each gate one feature.

4. **Run the development server**
```bash
   bun run dev
```

5. **Open in browser**
   Visit http://localhost:3000

> The server validates its environment on start (see `src/instrumentation.ts`)
> and refuses to boot with every missing variable listed at once. If it does
> not come up, check `.env` against `.env.example`.

### Resend sender limitation

Confirmation email is sent through Resend. On the free tier Resend only
delivers to the address on the account itself, so a confirmation addressed to
a patient will not arrive until a sending domain is verified. `EMAIL_FROM`
defaults to `onboarding@resend.dev`, which has the same restriction. This is
a Resend account limitation, not a bug in the app.

## How to Demo

1. Fill out and submit the intake form in your preferred language
2. Get the email with the appointment information automatically

### If you want to observe the AI agent conversation (Optional):
2. Open the browser console (F12 or right-click → Inspect → Console)
3. Copy the spectate URL shown in the console (optional - for observing the AI process)
4. Navigate to the spectate URL
5. Click "Start Conversation" to hear the simulated appointment booking call
6. Click "Stop" once the agents have reached an agreement
7. Check your email for the confirmation message in the language you originally selected

## Project Structure
```
├── src/
│   ├── app/
│   │   ├── page.tsx              # Landing page, language picker
│   │   ├── language/[slug]/      # Localized intake form
│   │   ├── spectate/[id]/        # Voice session viewer (server wrapper + client)
│   │   ├── api/
│   │   │   ├── intake/           # Intake form submission
│   │   │   ├── appointments/     # Appointment read/create
│   │   │   ├── webhook/          # Internal email dispatcher
│   │   │   ├── audit/            # Audit log read/write
│   │   │   └── health/           # Health check endpoint
│   │   ├── instrumentation.ts    # Boot-time environment validation
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── actions.ts
│   ├── config/                   # Non-secret application configuration
│   └── lib/
│       ├── env.ts                # Environment schema (source of truth)
│       ├── translateFromEnglish.ts
│       ├── translateToEnglish.ts
│       ├── appointments.ts
│       ├── audit.ts
│       └── encryption.ts
├── scripts/
│   └── verify-hipaa.ts           # Encryption + audit chain checks
├── public/
├── package.json
├── next.config.ts
├── postcss.config.mjs            # Tailwind v4 is configured here
└── tsconfig.json
```

## The Problem We're Solving

Millions of people struggle to book medical appointments due to:
- Language barriers in healthcare systems
- Time constraints (can't call during business hours)
- Phone anxiety or difficulty navigating automated systems
- Lack of internet access to online booking portals

Medilin removes these barriers by having AI handle the entire booking process on the patient's behalf.
