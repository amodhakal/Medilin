import type { MedicalDepartment, SupportedLanguage } from "@/lib/validation/intake";

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
} as const;

/** Exported so a test can hold every language to the English key set. */
export const ENGLISH_MESSAGES = ENGLISH;

export type MessageKey = keyof typeof ENGLISH;

export type Messages = { readonly [K in MessageKey]: string };

export type TextDirection = "ltr" | "rtl";

export interface LanguageDefinition {
  /** BCP-47 tag. The `lang` attribute is its primary subtag. */
  readonly locale: string;
  readonly direction: TextDirection;
  /** Endonym: the language's name in that language, never translated. */
  readonly name: string;
  /**
   * Regional flag. Decorative on its own, so it is always rendered next to
   * `name` as text rather than as the only label.
   */
  readonly flag: string;
  /** One line, in this language, on what choosing it gets you. */
  readonly description: string;
  readonly messages: Messages;
}

const DEFINITIONS = {
  english: {
    locale: "en",
    direction: "ltr",
    name: "English",
    flag: "🇺🇸",
    description: "Seamless voice intake in English",
    messages: ENGLISH,
  },
  spanish: {
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
    },
  },
  portuguese: {
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
    },
  },
} as const satisfies Record<string, LanguageDefinition>;

/**
 * The registry. Typed from the data, so the slug union cannot drift from the
 * entries that exist.
 */
export const LANGUAGES = DEFINITIONS;

export type LanguageSlug = keyof typeof DEFINITIONS;

/**
 * Every language the UI can offer, in presentation order.
 *
 * Derived from the registry rather than written out, because a hand-maintained
 * second list is exactly the drift this module exists to remove. The `as` is
 * sound: the keys of an object literal are known to TypeScript, and
 * registry.test.ts asserts this array against the server's own language list.
 */
export const LANGUAGE_SLUGS = Object.keys(DEFINITIONS) as LanguageSlug[];

/** The language used when nothing better is known. */
export const DEFAULT_LANGUAGE: LanguageSlug = "english";

/**
 * Compile-time guarantee that the UI covers the languages the intake schema
 * accepts. Adding a language to the server's enum without registering it here
 * stops the build instead of producing a form the server rejects.
 */
type AssertNever<T extends never> = T;
export type RegistryCoversServerLanguages = AssertNever<
  SupportedLanguage extends LanguageSlug ? never : ["missing from the registry", SupportedLanguage]
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

/** Look up a language, falling back to the default. Never throws. */
export function resolveLanguage(slug: string): LanguageDefinition {
  return isLanguageSlug(slug) ? DEFINITIONS[slug] : DEFINITIONS[DEFAULT_LANGUAGE];
}

export function messagesFor(slug: string): Messages {
  return resolveLanguage(slug).messages;
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
