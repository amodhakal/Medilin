import type {
  IntakeFormData,
  MedicalDepartment,
  SupportedLanguage,
} from "@/lib/validation/intake";

/**
 * The single definition of what a language is in this app.
 *
 * The language list and the message dictionary used to live in two places: a
 * three-element array in the home page and a 76-line literal in the language
 * page. Both were typed as `Record<string, string>` or a bare union, so nothing
 * stopped a message from being renamed in one place and left stale in the
 * other, and nothing stopped a language from being listed on the home page
 * while being absent from the dictionary, which then rendered English.
 *
 * English is the source of truth for the message set. Every other language is
 * checked against it with `satisfies`, so a missing key is a type error, a
 * renamed key is a type error, and a value that is not a string is a type
 * error. `LANGUAGES` is typed from the data, so a new entry is immediately
 * available everywhere and cannot be half-registered.
 *
 * Types only, deliberately, from the intake schema. `MEDICAL_DEPARTMENTS` and
 * `SUPPORTED_LANGUAGES` are the server's authority on the same two questions,
 * and a client bundle has no business paying for zod to read a string array:
 * the values are pinned by the checks below and by registry.test.ts, which
 * imports the real constants and compares them.
 */

/**
 * The message set, in English.
 *
 * This is the shape every other language has to satisfy. Adding a string here
 * is a compile error in every language that has not translated it yet, which
 * is the point: a missing translation must not ship as an empty label.
 */
const ENGLISH = {
  title: "Patient Intake Form",
  subtitle: "Complete your details to initiate AI receptionist consultation",
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email Address",
  dob: "Date of Birth",
  insurance: "Do you have insurance?",
  phone: "Doctor's Phone Number",
  appointmentDateTime: "Appointment Date & Time",
  whoToVisit: "Medical Department",
  additionalInfo: "Additional Information / Symptoms",
  submit: "Initiate Voice Consultation",
  yes: "Yes",
  no: "No",
  selectOption: "-- Select Department --",
  doctor: "General Practitioner",
  eyeDoctor: "Ophthalmology (Eye)",
  dentist: "Dental Care",
  pediatrician: "Pediatrics",
  psychiatrist: "Psychiatry & Mental Health",
  other: "Specialist Consultation",
  toastProcessing: "Processing intake & spinning up AI Agent...",
  back: "Back to Languages",
  notFoundTitle: "That language is not available",
  skipToForm: "Skip to the form",
  lowBandwidth: "Reduce data use",
  notFoundBody:
    "This address does not match a language we offer. Pick one of the languages below to start.",
  pickLanguage: "Choose a language",
  startIntake: "Start intake",
  comingSoon: "Coming soon",
  notYetBookable: "Not yet available for booking",
  fixErrors: "Check these fields",
  submitting: "Starting your consultation",
  bookedTitle: "Your appointment is booked",
  bookedBody:
    "The voice receptionist is ready for you. Your details are confirmed and a copy is on its way to your email.",
  joinCall: "Join the voice consultation",
  reference: "Reference",
  showLink: "Show the link",
  stayHere: "Stay on this page",
  redirectingIn: "Taking you to the consultation in {seconds} seconds.",
  redirectingInOne: "Taking you to the consultation in one second.",
  resumeRedirect: "Go to the consultation automatically",
  redirectingNotice:
    "You will be taken to the voice consultation automatically. Use the link above, or stay on this page.",
  submitFailed: "Your details could not be sent. Nothing has been booked.",
  firstNamePlaceholder: "Jordan",
  lastNamePlaceholder: "Reyes",
  emailPlaceholder: "jordan.reyes@example.com",
  phonePlaceholder: "+1 (555) 019 2834",
  additionalInfoPlaceholder: "Describe your symptoms, or why you are coming in.",
} as const;

/** Exported so a test can hold every language to the English key set. */
export const ENGLISH_MESSAGES = ENGLISH;

export type MessageKey = keyof typeof ENGLISH;

export type Messages = { readonly [K in MessageKey]: string };

/**
 * Fill `{name}` placeholders in a translated string.
 *
 * Deliberately not a template language. A message is a sentence with a number
 * in it, and the only thing that has to be true of the translation is that it
 * can put the number where its language puts it, which the placeholder
 * position in the string decides. Anything more expressive is a thing to
 * translate badly rather than a thing to translate well.
 *
 * An unknown placeholder is left as written rather than replaced with the
 * parameter's name, so a visible `{countdown}` on a page is a missing
 * argument in the calling code, which is findable, instead of a sentence with
 * a word in the wrong language in it.
 */
export function formatMessage(
  template: string,
  params: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export type TextDirection = "ltr" | "rtl";

/** What every language has, translated or not. */
export interface LanguageBasics {
  /** BCP-47 tag. The `lang` attribute is its primary subtag. */
  readonly locale: string;
  /**
   * Reading direction. Read from the registry rather than inferred from the
   * locale, because inference from a language subtag is a table of exceptions
   * (Azerbaijani is written both ways, Hebrew was, Serbian is in Latin script
   * in Bosnia) and this app is not going to maintain one.
   */
  readonly direction: TextDirection;
  /** Endonym: the language's name in that language, never translated. */
  readonly name: string;
  /**
   * Regional flag. Decorative on its own, so it is always rendered next to
   * `name` as text rather than as the only label.
   */
  readonly flag: string;
}

/**
 * A language a patient can actually book in.
 *
 * A live language has to be able to answer every string in the dictionary, so
 * `messages` is the full `Messages` and not a subset. That is what makes
 * "flip the status and ship" impossible: the change is a compile error until
 * the strings are there.
 */
export type LiveLanguage = LanguageBasics & {
  readonly status: "live";
  /** One line, in this language, on what choosing it gets you. */
  readonly description: string;
  readonly messages: Messages;
};

/**
 * A language we intend to offer and are not ready to book in.
 *
 * No dictionary, because a draft of a medical form in a language we cannot
 * review is worse than no form: "Date of Birth" mistranslated into a
 * discharge instruction is not a cosmetic problem. So a pending language
 * carries its locale, direction, endonym, and flag -- the things a native
 * speaker can check without a translator -- and nothing else. It is announced
 * on the language picker as coming, and it has no page, no hreflang entry, and
 * no sitemap entry, because advertising a document that does not exist is
 * worse than not advertising it.
 */
export type PendingLanguage = LanguageBasics & {
  readonly status: "pending";
  /**
   * A partial dictionary, for translating ahead of time. Never rendered: the
   * form and its chrome read `messagesFor`, which only answers for a live
   * language.
   */
  readonly messages?: Partial<Messages>;
};

export type LanguageDefinition = LiveLanguage | PendingLanguage;

const DEFINITIONS = {
  english: {
    status: "live",
    locale: "en",
    direction: "ltr",
    name: "English",
    flag: "🇺🇸",
    description: "Seamless voice intake in English",
    messages: ENGLISH,
  },
  spanish: {
    status: "live",
    locale: "es",
    direction: "ltr",
    name: "Español",
    flag: "🇪🇸",
    description: "Admisión médica guiada por voz en español",
    messages: {
      title: "Formulario de Admisión",
      subtitle: "Complete sus datos para iniciar la consulta con el recepcionista de IA",
      firstName: "Nombre",
      lastName: "Apellido",
      email: "Correo Electrónico",
      dob: "Fecha de Nacimiento",
      insurance: "¿Tiene seguro médico?",
      phone: "Número de Teléfono del Doctor",
      appointmentDateTime: "Fecha y Hora de la Cita",
      whoToVisit: "Departamento Médico",
      additionalInfo: "Información Adicional / Síntomas",
      submit: "Iniciar Consulta por Voz",
      yes: "Sí",
      no: "No",
      selectOption: "-- Seleccionar Departamento --",
      doctor: "Médico General",
      eyeDoctor: "Oftalmología",
      dentist: "Odontología",
      pediatrician: "Pediatría",
      psychiatrist: "Psiquiatría y Salud Mental",
      other: "Consulta Especializada",
      toastProcessing: "Procesando admisión y conectando Agente IA...",
      back: "Volver a Idiomas",
      notFoundTitle: "Ese idioma no está disponible",
      skipToForm: "Ir al formulario",
      lowBandwidth: "Reducir el uso de datos",
      notFoundBody:
        "Esta dirección no corresponde a ningún idioma que ofrezcamos. Elige uno de los idiomas siguientes para comenzar.",
      pickLanguage: "Elegir un idioma",
      startIntake: "Iniciar admisión",
      comingSoon: "Próximamente",
      notYetBookable: "Aún no disponible para reservar",
      fixErrors: "Revisa estos campos",
      submitting: "Iniciando tu consulta",
      bookedTitle: "Tu cita está reservada",
      bookedBody:
        "La recepcionista de IA está lista para atenderte. Tus datos están confirmados y recibirás una copia por correo electrónico.",
      joinCall: "Entrar en la consulta por voz",
      reference: "Referencia",
      showLink: "Mostrar el enlace",
      stayHere: "Quedarme en esta página",
      redirectingIn: "Te llevaremos a la consulta en {seconds} segundos.",
      redirectingInOne: "Te llevaremos a la consulta en un segundo.",
      resumeRedirect: "Ir a la consulta automáticamente",
      redirectingNotice:
        "Entrarás automáticamente en la consulta por voz. Usa el enlace de arriba o quédate en esta página.",
      submitFailed: "No se pudieron enviar tus datos. No se ha reservado nada.",
      firstNamePlaceholder: "Jordan",
      lastNamePlaceholder: "Reyes",
      emailPlaceholder: "jordan.reyes@ejemplo.com",
      phonePlaceholder: "+34 600 123 456",
      additionalInfoPlaceholder:
        "Describe tus síntomas o el motivo de tu visita.",
    },
  },
  portuguese: {
    status: "live",
    locale: "pt-BR",
    direction: "ltr",
    name: "Português",
    flag: "🇧🇷",
    description: "Triagem de pacientes por voz em português",
    messages: {
      title: "Formulário de Admissão",
      subtitle: "Preencha seus dados para iniciar a consulta com o recepcionista de IA",
      firstName: "Nome",
      lastName: "Sobrenome",
      email: "Endereço de E-mail",
      dob: "Data de Nascimento",
      insurance: "Você possui seguro médico?",
      phone: "Telefone do Médico",
      appointmentDateTime: "Data e Hora da Consulta",
      whoToVisit: "Departamento Médico",
      additionalInfo: "Informações Adicionais / Sintomas",
      submit: "Iniciar Consulta por Voz",
      yes: "Sim",
      no: "Não",
      selectOption: "-- Selecionar Departamento --",
      doctor: "Clínico Geral",
      eyeDoctor: "Oftalmologia",
      dentist: "Odontologia",
      pediatrician: "Pediatria",
      psychiatrist: "Psiquiatria e Saúde Mental",
      other: "Consulta Especializada",
      toastProcessing: "Processando admissão e iniciando Agente de Voz...",
      back: "Voltar para Idiomas",
      notFoundTitle: "Esse idioma não está disponível",
      skipToForm: "Ir para o formulário",
      lowBandwidth: "Reduzir o uso de dados",
      notFoundBody:
        "Este endereço não corresponde a nenhum idioma que oferecemos. Escolha um dos idiomas abaixo para começar.",
      pickLanguage: "Escolher um idioma",
      startIntake: "Iniciar admissão",
      comingSoon: "Em breve",
      notYetBookable: "Ainda não disponível para agendamento",
      fixErrors: "Verifique estes campos",
      submitting: "Iniciando sua consulta",
      bookedTitle: "Sua consulta está agendada",
      bookedBody:
        "A recepcionista de voz está pronta para atender você. Seus dados estão confirmados e uma cópia chegará por e-mail.",
      joinCall: "Entrar na consulta por voz",
      reference: "Referência",
      showLink: "Mostrar o link",
      stayHere: "Ficar nesta página",
      redirectingIn: "Levaremos você à consulta em {seconds} segundos.",
      redirectingInOne: "Levaremos você à consulta em um segundo.",
      resumeRedirect: "Ir para a consulta automaticamente",
      redirectingNotice:
        "Você será levado à consulta por voz automaticamente. Use o link acima ou fique nesta página.",
      submitFailed: "Não foi possível enviar seus dados. Nada foi agendado.",
      firstNamePlaceholder: "Jordan",
      lastNamePlaceholder: "Reyes",
      emailPlaceholder: "jordan.reyes@exemplo.com",
      phonePlaceholder: "+55 11 91234 5678",
      additionalInfoPlaceholder:
        "Descreva seus sintomas ou o motivo da consulta.",
    },
  },

  /*
   * Waiting on translation, and on the server.
   *
   * Each of these is one registry entry and no code. What a language needs to
   * go live: a native speaker's reviewed dictionary, `status: "live"`, and its
   * slug added to SUPPORTED_LANGUAGES in src/lib/validation/intake.ts -- the
   * last of which is a one-line change in a file this work does not own,
   * because the intake schema validates the language a record is written in,
   * and offering a language the server refuses means every submission from
   * that language fails validation.
   *
   * French and Mandarin are LTR; Arabic and Hebrew are RTL, and they are here
   * as much to keep the right-to-left path exercised and visible as to expand
   * coverage.
   */
  french: {
    status: "pending",
    locale: "fr",
    direction: "ltr",
    name: "Français",
    flag: "🇫🇷",
  },
  mandarin: {
    status: "pending",
    locale: "zh-Hans",
    direction: "ltr",
    name: "中文",
    flag: "🇨🇳",
  },
  arabic: {
    status: "pending",
    locale: "ar",
    direction: "rtl",
    name: "العربية",
    flag: "🇸🇦",
  },
  hebrew: {
    status: "pending",
    locale: "he",
    direction: "rtl",
    name: "עברית",
    flag: "🇮🇱",
  },
} as const satisfies Record<string, LanguageDefinition>;

/**
 * The registry. Typed from the data, so the slug union cannot drift from the
 * entries that exist.
 */
export const LANGUAGES = DEFINITIONS;

export type LanguageSlug = keyof typeof DEFINITIONS;

/**
 * Every language the registry knows about, in presentation order.
 *
 * Derived from the registry rather than written out, because a hand-maintained
 * second list is exactly the drift this module exists to remove. The `as` is
 * sound: the keys of an object literal are known to TypeScript, and
 * registry.test.ts asserts this array against the registry itself.
 */
export const LANGUAGE_SLUGS = Object.keys(DEFINITIONS) as LanguageSlug[];

/**
 * The language used when nothing better is known, and the language the picker
 * and the not-found page are written in.
 *
 * A literal rather than a `LanguageSlug`, so that looking the default up
 * resolves to the English entry and not to the union of every language, which
 * is what `LANGUAGES[DEFAULT_LANGUAGE]` would otherwise be.
 */
export const DEFAULT_LANGUAGE = "english" satisfies LanguageSlug;

/** The slugs of the languages a patient can book in, derived from the data. */
export type LiveLanguageSlug = {
  [K in LanguageSlug]: (typeof DEFINITIONS)[K] extends { status: "live" }
    ? K
    : never;
}[LanguageSlug];

export function isLiveLanguage(slug: LanguageSlug): slug is LiveLanguageSlug {
  return DEFINITIONS[slug].status === "live";
}

/**
 * Bookable languages, in presentation order.
 *
 * This is the list the language picker links to, the list the language route
 * prerenders, and the list hreflang alternates and the sitemap advertise,
 * because all four are statements that a page exists at a URL. A pending
 * language has none of those.
 */
export const LIVE_LANGUAGE_SLUGS: LiveLanguageSlug[] =
  LANGUAGE_SLUGS.filter(isLiveLanguage);

/** Languages we intend to offer and cannot book in yet. */
export const PENDING_LANGUAGE_SLUGS: LanguageSlug[] =
  LANGUAGE_SLUGS.filter((slug) => !isLiveLanguage(slug));

/**
 * Compile-time guarantees about the server.
 *
 * The intake schema has its own list of languages, in a file this work does not
 * own, and the two have to agree in one direction or the other: every language
 * the server accepts must exist here, and every language the server accepts
 * must be live, because a record submitted in a language the schema rejects
 * fails validation and the patient is told to check their fields. Adding a
 * language to SUPPORTED_LANGUAGES without registering it here, or registering
 * it as pending, stops the build.
 */
type AssertNever<T extends never> = T;
export type RegistryCoversServerLanguages = AssertNever<
  SupportedLanguage extends LanguageSlug
    ? never
    : ["missing from the registry", SupportedLanguage]
>;
export type ServerLanguagesAreBookable = AssertNever<
  Exclude<SupportedLanguage, LiveLanguageSlug> extends never
    ? never
    : ["registered but not bookable", Exclude<SupportedLanguage, LiveLanguageSlug>]
>;

/**
 * Narrows an untrusted string, usually a route parameter.
 *
 * Every lookup in this module goes through this, because `LANGUAGES` is a plain
 * object: indexing it with an arbitrary string returns a member of
 * `Object.prototype` instead of undefined, which is the shape of a silent
 * fallback to garbage rather than to English.
 */
export function isLanguageSlug(value: string): value is LanguageSlug {
  return Object.hasOwn(DEFINITIONS, value);
}

export function getLanguage(slug: LanguageSlug): LanguageDefinition {
  return DEFINITIONS[slug];
}

/** A bookable language, with the slug that named it. */
export interface BookableLanguage {
  readonly slug: LiveLanguageSlug;
  readonly language: LiveLanguage;
}

/**
 * Resolve a route parameter to a language that can be booked in, or null.
 *
 * Null for a slug that is not in the registry and for one that is registered
 * but pending. A pending language has no form, so serving it a page would mean
 * rendering a form in a language we cannot translate, or serving English under
 * a URL that says otherwise. Both callers treat null as not found.
 */
export function resolveBookableLanguage(slug: string): BookableLanguage | null {
  if (!isLanguageSlug(slug) || !isLiveLanguage(slug)) return null;
  return { slug, language: DEFINITIONS[slug] };
}

/**
 * The message set for a language.
 *
 * Answers for a live language and falls back to the default for anything else,
 * including a pending one, whose dictionary is either absent or a partial
 * draft. Every string in the form is read through here, so a page can never
 * render `undefined` because a language is half-translated.
 */
export function messagesFor(slug: string): Messages {
  const language = isLanguageSlug(slug) ? DEFINITIONS[slug] : undefined;
  return language?.status === "live"
    ? language.messages
    : DEFINITIONS[DEFAULT_LANGUAGE].messages;
}

/** The primary subtag, for the `lang` attribute. */
export function htmlLang(language: LanguageDefinition): string {
  return language.locale.split("-")[0];
}

export interface DepartmentOption {
  /** Exactly the value the intake schema accepts. */
  readonly value: MedicalDepartment;
  readonly messageKey: MessageKey;
}

/**
 * The department dropdown, in the order the form shows it.
 *
 * The option values are the server's `MEDICAL_DEPARTMENTS` and the labels are
 * this registry's messages, so the two halves cannot disagree. registry.test.ts
 * compares this list against the real constant; keeping the constant out of
 * this module keeps zod out of the client bundle.
 */
export const DEPARTMENT_OPTIONS: readonly DepartmentOption[] = [
  { value: "Doctor", messageKey: "doctor" },
  { value: "Eye Doctor", messageKey: "eyeDoctor" },
  { value: "Dentist", messageKey: "dentist" },
  { value: "Pediatrician", messageKey: "pediatrician" },
  { value: "Psychiatrist", messageKey: "psychiatrist" },
  { value: "Other", messageKey: "other" },
];

/**
 * The fields a patient fills in.
 *
 * `language` is not one of them: it comes from the route, not from an input.
 * Derived from the intake schema, so a field cannot be added to the form
 * without also being labelable.
 */
export type IntakeFieldName = Exclude<keyof IntakeFormData, "language">;

/**
 * Form field name to the message that labels it.
 *
 * The server reports validation problems as `{ field, message }` with the
 * field name as the input's `name`, so this is the mapping that turns a
 * `FieldIssue` into something a patient can act on. Typed against the intake
 * schema: a renamed input is a compile error here, and an issue naming a
 * field this form does not have is handled as unattached rather than rendered
 * next to the wrong control.
 */
export const FIELD_LABELS = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  dob: "dob",
  insurance: "insurance",
  phone: "phone",
  appointmentDateTime: "appointmentDateTime",
  medical_department: "whoToVisit",
  additionalInfo: "additionalInfo",
} as const satisfies Record<IntakeFieldName, MessageKey>;

/** Every field a patient fills in, in the order the form shows them. */
export const INTAKE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "dob",
  "insurance",
  "phone",
  "appointmentDateTime",
  "medical_department",
  "additionalInfo",
] as const satisfies readonly IntakeFieldName[];
