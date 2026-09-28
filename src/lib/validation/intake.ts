import { z } from "zod";

/**
 * Shared intake validation.
 *
 * These schemas are the single definition of a valid intake submission. The
 * client form, the server action, and the API routes all validate against
 * them, so a field cannot be required in the form and optional on the server
 * or vice versa. Validation is `.strict()` throughout: unknown keys are
 * rejected rather than dropped, so a caller cannot smuggle extra fields
 * through to storage.
 */

export const MEDICAL_DEPARTMENTS = [
  "Doctor",
  "Eye Doctor",
  "Dentist",
  "Pediatrician",
  "Psychiatrist",
  "Other",
] as const;

export type MedicalDepartment = (typeof MEDICAL_DEPARTMENTS)[number];

export const SUPPORTED_LANGUAGES = [
  "english",
  "spanish",
  "portuguese",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** `datetime-local` submits `YYYY-MM-DDTHH:mm`, with no zone. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(100, "Too long");

export const intakeSchema = z
  .object({
    firstName: nameField,
    lastName: nameField,
    email: z.email("Enter a valid email address").max(254),
    dob: z
      .string()
      .regex(ISO_DATE, "Use YYYY-MM-DD")
      .refine(isRealDate, "Enter a real date"),
    insurance: z.enum(["yes", "no"]),
    phone: z
      .string()
      .trim()
      .min(5, "Enter a phone number")
      .max(40, "Too long"),
    appointmentDateTime: z
      .string()
      .regex(LOCAL_DATE_TIME, "Use YYYY-MM-DDTHH:mm")
      .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a real date and time"),
    medical_department: z.enum(MEDICAL_DEPARTMENTS),
    additionalInfo: z.string().trim().max(2000, "Too long").default(""),
    language: z.enum(SUPPORTED_LANGUAGES).default("english"),
  })
  .strict();

export type IntakeFormData = z.infer<typeof intakeSchema>;

/**
 * The patient record as it exists after translation.
 *
 * Kept separate from `intakeSchema` because translation can alter the values
 * but must never alter the shape: `translateToEnglish` used to spread the
 * model's output straight over the submitted record, so a response carrying
 * an extra key would silently overwrite a real field.
 */
export const appointmentRecordSchema = z
  .object({
    firstName: nameField,
    lastName: nameField,
    email: z.email().max(254),
    dob: z.string().regex(ISO_DATE).refine(isRealDate),
    insurance: z.enum(["yes", "no"]),
    phone: z.string().trim().min(5).max(40),
    appointmentDateTime: z.string().min(1),
    medical_department: z.string().trim().min(1).max(100),
    additionalInfo: z.string().max(2000),
    language: z.enum(SUPPORTED_LANGUAGES),
  })
  .strict();

export type AppointmentRecord = z.infer<typeof appointmentRecordSchema>;

/** Payload accepted by the internal email dispatcher. */
export const webhookPayloadSchema = z
  .object({
    email: z.email().max(254),
    language: z.enum(SUPPORTED_LANGUAGES),
    info: z.string().min(1).max(20_000),
  })
  .strict();

/** Payload accepted by the appointment API. */
export const appointmentRequestSchema = intakeSchema;

/**
 * Read a submission out of FormData.
 *
 * FormData is a string map, so every value arrives as a string or a File.
 * Anything that is not a string is a shape the form does not produce, and is
 * reported as invalid rather than coerced.
 */
export function intakeFromFormData(formData: FormData): unknown {
  const raw: Record<string, unknown> = {};

  for (const key of Object.keys(intakeSchema.shape)) {
    const value = formData.get(key);
    if (value !== null) {
      raw[key] = typeof value === "string" ? value : value.name;
    }
  }

  return raw;
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
