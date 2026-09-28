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

const dobField = z
  .string()
  .regex(ISO_DATE, "Use YYYY-MM-DD")
  .refine(isRealDate, "Enter a real date");

/**
 * How a dependent is related to the person filling in the form.
 *
 * A closed list rather than free text, for the same reason `insurance` is
 * `yes | no`: it is a triage hint, and a clinician filtering a day's list by
 * "is this a child" needs a value they can match on.
 */
export const DEPENDENT_RELATIONSHIPS = [
  "child",
  "spouse",
  "parent",
  "sibling",
  "other",
] as const;

export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

/**
 * How many other people one booking may carry.
 *
 * A cap rather than an open list, and the reasons are cost and clinical sanity
 * as much as abuse control. Each person is another record in one booking, another
 * translation call, another block of free text a model is later asked to
 * summarise, and another set of decisions a single voice consultation has to
 * cover. Past a handful of people this is a conversation with the clinic about
 * scheduling, not something an intake form should be accepting. An uncapped
 * array is also a way to spend the whole API budget by submitting one field a
 * few thousand times.
 */
export const MAX_DEPENDENTS = 5;

/**
 * Highest index this app will look at in a submitted household.
 *
 * `MAX_DEPENDENTS` bounds the list that gets *validated*, which is not the same
 * as bounding the list that gets *built*. A submission containing
 * `dependents.0` through `dependents.99999` passes every syntactic check and
 * makes the reader allocate a hundred thousand objects before zod ever sees it,
 * so the cap that matters for cost is on the index.
 *
 * Comfortably above `MAX_DEPENDENTS` on purpose: removing a person from the
 * middle of a household in the browser leaves a gap, and a client that does not
 * renumber the rest is still describing a real household.
 */
const MAX_DEPENDENT_INDEX = 50;

/**
 * One other person in the same booking.
 *
 * Not the whole `intakeSchema`, deliberately. A dependent has no email address,
 * no phone number and no appointment slot of their own: this is one slot in a
 * household's booking, not a second booking. They have a name, a date of birth,
 * a relationship to the account holder, and their own account of why they are
 * coming in.
 *
 * `lastName` is optional and the reason is worth stating, because it looks like
 * an oversight. A child brought in by a parent is usually recorded under the
 * parent's surname, which is already on the booking, or under a name the parent
 * does not think to type because it is not how they refer to the child. Requiring
 * it pushes people to invent one, and an invented surname on a clinical record
 * is a worse outcome than an absent one.
 *
 * `.strict()`, like every other schema here.
 */
export const dependentSchema = z
  .object({
    firstName: nameField,
    lastName: nameField.optional(),
    dob: dobField,
    relationship: z.enum(DEPENDENT_RELATIONSHIPS),
    additionalInfo: z.string().trim().max(2000, "Too long").default(""),
  })
  .strict();

export type Dependent = z.infer<typeof dependentSchema>;

/**
 * The household list, shared by the intake form and the stored record.
 *
 * Optional and *not* defaulted, which is the one decision that makes this change
 * genuinely additive.
 *
 * A default of `[]` would be the more convenient type -- everything downstream
 * could read `record.dependents` without a guard. It would also put
 * `"dependents":[]` into the JSON of every single-patient submission, and that
 * JSON is what gets sealed into the spectate and tracking tokens: eighteen bytes
 * of ciphertext in every link a patient is handed, carrying no information,
 * forever, for every one-person booking. The token is already as long as the
 * record and those links get copied into text messages and printed on
 * paperwork.
 *
 * So absent stays absent. `AppointmentRecord.dependents` is `Dependent[] |
 * undefined`, every reader uses `?? []`, and a booking made by one person
 * produces byte-for-byte the record it produced before this issue existed --
 * which the token-length assertion in src/app/actions.test.ts checks on every
 * run.
 */
const dependentsField = z
  .array(dependentSchema)
  .max(MAX_DEPENDENTS, `At most ${MAX_DEPENDENTS} other people`)
  .optional();

export const intakeSchema = z
  .object({
    firstName: nameField,
    lastName: nameField,
    email: z.email("Enter a valid email address").max(254),
    dob: dobField,
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
    /**
     * Everyone else in the same booking, defaults to none.
     *
     * The compatibility requirement for the whole of household support: a
     * submission that has never heard of this key is unchanged, and the key is
     * the only thing added to a record that used to have ten fields.
     */
    dependents: dependentsField,
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
    // Constrained to the same enum as the form. The model translates a
    // department label from the patient's language into English, and that
    // translation has to land on one of the values the form actually offers.
    medical_department: z.enum(MEDICAL_DEPARTMENTS),
    additionalInfo: z.string().max(2000),
    language: z.enum(SUPPORTED_LANGUAGES),
    /**
     * Permitted rather than defaulted.
     *
     * This schema re-validates every record on its way through translation, and
     * every record stored before household support -- and every fixture in this
     * repo -- has no `dependents` key at all. Defaulting it here would add
     * `dependents: []` to all of them and quietly stop a stored record being
     * equal to what went in. Permitted, validated the same as the rest, and
     * absent stays absent.
     */
    dependents: z
      .array(dependentSchema)
      .max(MAX_DEPENDENTS, `At most ${MAX_DEPENDENTS} other people`)
      .optional(),
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
 * Payload accepted by the internal clinician summary endpoint.
 *
 * The only way to name a patient is the sealed token from src/lib/phi-token, and
 * this carries it in a request *body* rather than a query string for the same
 * reason that module exists: a token in a URL is a bearer credential in every
 * access log, browser history entry and Referer header on the path, and this one
 * decrypts to a record containing symptom text.
 *
 * `.strict()` like the rest, so a caller cannot attach a second field and have
 * it quietly accepted. There is no `appointmentId` alternative: the appointment
 * store is an in-memory `Map`, so an id resolves to nothing on any instance
 * that did not handle the write, and a "lookup by id" that silently returns
 * nothing is a worse failure than not offering one.
 */
export const intakeSummaryRequestSchema = z
  .object({
    token: z.string().trim().min(1, "Required").max(20_000, "Too long"),
  })
  .strict();

export type IntakeSummaryRequest = z.infer<typeof intakeSummaryRequestSchema>;

/**
 * Payload accepted by the audit write endpoint.
 *
 * Note that the caller supplies `actor`, which means a caller can attribute
 * an entry to anyone. Constraining it to a string bounds the damage but does
 * not solve it; the actor has to come from an authenticated identity, which
 * is what makes the audit trail worth having.
 */
export const auditEntrySchema = z
  .object({
    actor: z.string().trim().min(1).max(200),
    action: z.string().trim().min(1).max(100),
    resource: z.string().trim().min(1).max(200),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

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
    // Read separately: the household is a set of indexed keys, not one value.
    if (key === "dependents") continue;

    const value = formData.get(key);
    if (value !== null) {
      raw[key] = typeof value === "string" ? value : value.name;
    }
  }

  const dependents = dependentsFromFormData(formData);

  // Omitted rather than set to an empty array when there is no household. The
  // key is optional on both schemas so this is not a correctness requirement,
  // it is the token-length one: see dependentsField.
  if (dependents.length > 0) {
    raw.dependents = dependents;
  }

  return raw;
}

/**
 * The one shape a dependent field is allowed to have in a submission.
 *
 * `dependents.<index>.<field>`, and the index is the input's own `name` attribute
 * rather than a convention agreed with the browser. That is deliberate: a Zod
 * issue on this schema has a path like `["dependents", 1, "dob"]`, which joins to
 * exactly this string, so the message the form renders can be matched to the
 * input that caused it without a second lookup table that could disagree.
 */
const DEPENDENT_FIELD = /^dependents\.(0|[1-9]\d*)\.(firstName|lastName|dob|relationship|additionalInfo)$/;

/**
 * Collect the household out of a FormData.
 *
 * Three things this has to get right, and each has a test.
 *
 * The pattern is anchored on both sides and the field list is explicit, because
 * FormData is a flat map a caller fully controls. `dependents.0.isAdmin` and
 * `dependents.x.firstName` are not dependent fields, and letting either through
 * would hand `.strict()` either a key it should reject or a person who does not
 * exist.
 *
 * Indices are collapsed to a dense array rather than written into their own
 * slots. A hand-built submission that sends only `dependents.3` would otherwise
 * produce `[undefined, undefined, undefined, {...}]`, and every error path a
 * patient sees is derived from the array position, so a hole would point Maya's
 * error at an empty card.
 *
 * An optional field the form did not submit is left out entirely rather than set
 * to `""`, so `lastName` stays genuinely absent.
 */
export function dependentsFromFormData(formData: FormData): unknown[] {
  const byIndex = new Map<number, Record<string, string>>();

  for (const [key, value] of formData.entries()) {
    const match = DEPENDENT_FIELD.exec(key);
    if (!match) continue;
    if (typeof value !== "string") continue;

    const index = Number(match[1]);
    // Bounds the array this loop builds, not just the one zod validates. See
    // MAX_DEPENDENT_INDEX.
    if (index > MAX_DEPENDENT_INDEX) continue;

    const person = byIndex.get(index) ?? {};
    person[match[2]] = value;
    byIndex.set(index, person);
  }

  return [...byIndex.keys()].sort((a, b) => a - b).map((index) => byIndex.get(index));
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
