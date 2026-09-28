# Medilin

**Live Demo:** https://sol-hacks2026.vercel.app

## Project Description

Medilin is a proof-of-concept multilingual healthcare appointment booking platform designed to help patients who face language barriers or time constraints when scheduling medical appointments. 

The vision is simple: patients fill out an intake form in their native language, and an AI agent automatically calls the clinic to book an appointment on their behalf. The patient receives a confirmation email, so no phone calls, no language barriers, no hassle.

**Current Demo Status:** This hackathon prototype demonstrates the core AI voice negotiation technology. When a patient submits an intake form, the system automatically simulates a hospital booking response with a negotiated appointment time (different from the requested time) and sends a confirmation email. The spectate URL allows optional observation of the AI agent conversation.

### How It Works

1. **Patient Intake**: Users fill out a healthcare intake form in their preferred language
2. **Automated Booking**: The system simulates a hospital response with a negotiated appointment time
3. **Confirmation**: The patient automatically receives a confirmation email with appointment details in their chosen language
4. **Optional Observation**: Users can visit the spectate URL to observe the AI agent conversation simulating the booking process

### Production Vision

In a production deployment, the AI agent would:
- Actually call the healthcare provider's scheduling line
- Handle real availability checks and calendar integration
- Manage conflicts and rescheduling
- Integrate with clinic EMR/scheduling systems
- Handle HIPAA compliance requirements

## Tech Stack

- **Frontend:** Next.js, React, Tailwind CSS
- **AI Voice:** ElevenLabs
- **AI Language Model:** Google Gemini
- **Email:** Resend
- **Deployment:** Vercel

## Setup Instructions

1. **Clone the repository**
```bash
   git clone https://github.com/amodhakal/SolHacks2026.git
   cd SolHacks2026
```

2. **Install dependencies**
```bash
   npm install
   # or
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
   npm run dev
   # or
   bun run dev
```

5. **Open in browser**
   Visit http://localhost:3000

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
│   │   ├── page.tsx              # Main intake form
│   │   ├── language/[slug]/      # Language-specific pages
│   │   ├── spectate/[id]/        # Spectator page for agent calls
│   │   ├── api/
│   │   │   ├── intake/           # Intake form submission
│   │   │   ├── appointments/     # Appointment booking
│   │   │   ├── webhook/          # ElevenLabs webhook handler
│   │   │   └── health/           # Health check endpoint
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── actions.ts
│   ├── components/
│   │   └── ElevenLabsProvider.tsx
│   └── lib/
│       ├── translateFromEnglish.ts
│       ├── translateToEnglish.ts
│       └── appointments.ts
├── public/
├── package.json
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

## The Problem We're Solving

Millions of people struggle to book medical appointments due to:
- Language barriers in healthcare systems
- Time constraints (can't call during business hours)
- Phone anxiety or difficulty navigating automated systems
- Lack of internet access to online booking portals

Medilin removes these barriers by having AI handle the entire booking process on the patient's behalf.
