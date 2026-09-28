/**
 * The copy for the voice intake screens, in each language we book in.
 *
 * Its own module rather than more keys in @/i18n/registry, for one reason: the
 * registry is the file every other language surface in this app is written
 * against, and a feature that has not shipped should not be able to add a
 * half-translated key to it and make a build fail for everyone else. Voice intake
 * is a new screen with new strings, and the registry's own rule -- a language
 * that cannot answer every string is not bookable -- is honoured here instead,
 * the same way, with `satisfies` and a closed key set.
 *
 * English is the key set. Every other language is checked against it, so a
 * missing or renamed key is a compile error and a new key cannot ship with an
 * empty label. Nothing here is medical copy; it is button text, and the one
 * judgement call in it is `notHeard`, which names the fields the recording did
 * not cover rather than a diagnosis.
 *
 * The field labels themselves are the form's own (`FIELD_LABELS` and
 * `messagesFor`), so a patient sees the same words for a field whichever way
 * they filled it in.
 */

const ENGLISH = {
  title: "Book by voice",
  subtitle: "Answer out loud instead of typing. We will fill the form in for you.",
  back: "Back to languages",
  record: "Start recording",
  stop: "Stop recording",
  recording: "Recording",
  working: "Reading your answers",
  listen: "Read my details back to me",
  speaking: "Reading aloud",
  confirm: "Confirm and book",
  submitting: "Booking your appointment",
  recordAgain: "Answer again",
  useTheForm: "Use the form instead",
  reviewTitle: "Check your details before we book",
  notHeard: "We did not hear these, so please fill them in",
  transcript: "What we heard",
  micRefused:
    "We could not use your microphone. Check your browser's permission for this site, or use the form instead.",
  notSupported:
    "This browser cannot record audio. Use the form instead, or try a different browser.",
  nothingHeard: "We could not hear that recording. Please try again.",
  tooLong: "That recording was too long. Please record a shorter answer.",
  unavailableTitle: "Voice intake is not available",
  unavailableBody:
    "This clinic is not set up for booking by voice right now. The form works exactly the same.",
  speakFailed: "We could not read that aloud.",
} as const;

export type VoiceMessageKey = keyof typeof ENGLISH;
export type VoiceMessages = { readonly [K in VoiceMessageKey]: string };

const COPY = {
  english: ENGLISH,
  spanish: {
    title: "Reservar por voz",
    subtitle:
      "Responde en voz alta en lugar de escribir. Nosotros rellenamos el formulario por ti.",
    back: "Volver a los idiomas",
    record: "Empezar a grabar",
    stop: "Detener la grabación",
    recording: "Grabando",
    working: "Leyendo tus respuestas",
    listen: "Leer mis datos en voz alta",
    speaking: "Leyendo en voz alta",
    confirm: "Confirmar y reservar",
    submitting: "Reservando tu cita",
    recordAgain: "Responder de nuevo",
    useTheForm: "Usar el formulario",
    reviewTitle: "Revisa tus datos antes de reservar",
    notHeard: "No escuchamos esto, así que complétalo tú",
    transcript: "Lo que escuchamos",
    micRefused:
      "No pudimos usar tu micrófono. Revisa el permiso del navegador para este sitio o usa el formulario.",
    notSupported:
      "Este navegador no puede grabar audio. Usa el formulario o prueba con otro navegador.",
    nothingHeard: "No escuchamos esa grabación. Inténtalo de nuevo, por favor.",
    tooLong: "Esa grabación fue demasiado larga. Graba una respuesta más corta.",
    unavailableTitle: "La reserva por voz no está disponible",
    unavailableBody:
      "Esta clínica no tiene activada la reserva por voz ahora mismo. El formulario funciona igual.",
    speakFailed: "No pudimos leerlo en voz alta.",
  },
  portuguese: {
    title: "Agendar por voz",
    subtitle:
      "Responda em voz alta em vez de escrever. Nós preenchemos o formulário para você.",
    back: "Voltar aos idiomas",
    record: "Começar a gravar",
    stop: "Parar a gravação",
    recording: "Gravando",
    working: "Lendo suas respostas",
    listen: "Ler meus dados em voz alta",
    speaking: "Lendo em voz alta",
    confirm: "Confirmar e agendar",
    submitting: "Agendando sua consulta",
    recordAgain: "Responder de novo",
    useTheForm: "Usar o formulário",
    reviewTitle: "Confira seus dados antes de agendar",
    notHeard: "Não ouvimos isto, então preencha você",
    transcript: "O que ouvimos",
    micRefused:
      "Não conseguimos usar seu microfone. Verifique a permissão do navegador para este site ou use o formulário.",
    notSupported:
      "Este navegador não consegue gravar áudio. Use o formulário ou tente outro navegador.",
    nothingHeard: "Não ouvimos essa gravação. Tente novamente, por favor.",
    tooLong: "Essa gravação foi longa demais. Grave uma resposta mais curta.",
    unavailableTitle: "O agendamento por voz não está disponível",
    unavailableBody:
      "Esta clínica não está com o agendamento por voz ativado no momento. O formulário funciona igual.",
    speakFailed: "Não conseguimos ler isso em voz alta.",
  },
} as const satisfies Record<string, VoiceMessages>;

export type VoiceCopySlug = keyof typeof COPY;

/**
 * The message set for a language, or English for anything unrecognised.
 *
 * `Object.hasOwn` first, for the same reason the registry checks it: indexing a
 * plain object with an arbitrary string returns a member of `Object.prototype`
 * rather than undefined, which is a silent fallback to nonsense rather than to
 * English.
 */
export function voiceMessages(slug: string): VoiceMessages {
  const copy = Object.hasOwn(COPY, slug) ? COPY[slug as VoiceCopySlug] : undefined;
  return copy ?? ENGLISH;
}

/** The key set, exported so a test can hold every language to it. */
export const VOICE_MESSAGE_KEYS = Object.keys(ENGLISH) as VoiceMessageKey[];
