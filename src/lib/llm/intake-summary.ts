import { getLlmClient, type LlmClient } from "@/lib/gemini";
import { buildIntakeSummaryPrompt, type IntakeSummaryFacts } from "./prompt";
import {
  INTAKE_SUMMARY_RESPONSE_SCHEMA,
  triageSummarySchema,
  type TriageSummary,
} from "./schema";

/**
 * A structured triage summary of one patient's own account of their symptoms.
 *
 * This is the first thing in the app that sends PHI to a model *for a purpose
 * other than translating it*, and it is a clinician-facing artefact rather than
 * a patient-facing one. Two consequences shape the whole module.
 *
 * The record it reads is `unknown`, because it arrives from a decrypted sealed
 * token rather than from the form. So the narrowing is an explicit allowlist,
 * not a cast, and it is the same argument as `toTrackSummary` on the tracking
 * page: a module that never puts a field into a prompt is a module no future
 * edit to it can leak one. The date of birth is reduced to a whole number of
 * years before it goes anywhere, because age is what triage uses and a date of
 * birth is a strong identifier that has no business in a prompt.
 *
 * A summary is not a translation of what the patient said. It is a second
 * reading of it, produced by something that can be confidently wrong, and it
 * will be read by a clinician as though every clause were the patient's account.
 * So the reply is validated again here even though the decoder was constrained,
 * an unparseable or out-of-shape reply is refused rather than repaired, and the
 * prompt forbids both naming a diagnosis and adding a fact nobody stated.
 */

/** What triage needs, and nothing that identifies the patient. */
export type IntakeSummaryInput = IntakeSummaryFacts;

const MAX_SYMPTOM_TEXT = 2000;
const MAX_DEPARTMENT = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEGREE_CEILING = 130;

/**
 * Whole years between a calendar date and `now`, or null.
 *
 * Read and compared entirely in UTC. The stored `dob` is a plain calendar date
 * with no zone, so a local-time reading of it would produce an age that depends
 * on which machine did the deriving -- and a summary that says a child is 10 on
 * one server and 11 on the next is a bug nobody would find.
 *
 * A future date, an unparseable one, and one that is not real (`1985-02-30`)
 * all give null. There is no sensible "age" for any of them, and the honest
 * answer to a clinician is that it was not stated.
 */
export function ageInYears(dob: string, now: Date): number | null {
  if (!ISO_DATE.test(dob)) return null;

  const [year, month, day] = dob.split("-").map(Number);
  const born = new Date(Date.UTC(year, month - 1, day));

  if (
    born.getUTCFullYear() !== year ||
    born.getUTCMonth() !== month - 1 ||
    born.getUTCDate() !== day
  ) {
    return null;
  }

  let age = now.getUTCFullYear() - year;
  const hadBirthday =
    now.getUTCMonth() > month - 1 ||
    (now.getUTCMonth() === month - 1 && now.getUTCDate() >= day);

  if (!hadBirthday) age -= 1;

  // A date in the future, or one implying an implausible age, is not a fact to
  // hand a model. Both are typos far more often than they are anything else.
  if (age < 0 || age > DEGREE_CEILING) return null;

  return age;
}

/**
 * Reduce a decrypted record to the facts a summary is made from.
 *
 * Null means "there is nothing to summarise", which is not an error: the
 * symptoms box is optional and most of the time it is empty. The caller must
 * not turn that into a model call.
 */
export function intakeSummaryInput(
  record: unknown,
  now: Date = new Date(),
): IntakeSummaryInput | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return null;
  }

  const source = record as Record<string, unknown>;

  const text = (key: string, max: number): string => {
    const value = source[key];
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  };

  // The patient's own words, and the only untrusted content in this module.
  const additionalInfo = text("additionalInfo", MAX_SYMPTOM_TEXT);
  if (!additionalInfo) return null;

  const dob = text("dob", 40);

  return {
    additionalInfo,
    // A department the form does not offer is still worth summarising. Refusing
    // the summary over it would make a record unreadable to a clinician
    // precisely when it is most likely to be an older or unusual one.
    medical_department: text("medical_department", MAX_DEPARTMENT) || "unspecified",
    ageYears: ageInYears(dob, now),
  };
}

/**
 * Ask the model for a summary of one record.
 *
 * `client` and `now` are parameters so a test can assert on the request and on
 * the age derivation without a live call or a clock, and so a caller with its
 * own client is not forced through the module-level one.
 *
 * Null is a refusal, not a transport fault: there was nothing to summarise, or
 * the reply did not survive `triageSummarySchema`. A failed call throws, so the
 * caller can tell "this patient said nothing" from "the summary pipeline is
 * down" -- which are very different things to show a clinician.
 */
export async function summariseIntake(
  record: unknown,
  client: LlmClient = getLlmClient(),
  now: Date = new Date(),
): Promise<TriageSummary | null> {
  const input = intakeSummaryInput(record, now);
  if (!input) return null;

  const reply = await client.generateJson({
    prompt: buildIntakeSummaryPrompt(input),
    responseSchema: INTAKE_SUMMARY_RESPONSE_SCHEMA,
  });

  // The decoder was constrained, so this is expected to pass. It is here
  // because constrained decoding is a statement about shape and this is a
  // clinical artefact: an unvalidated reply could carry an urgency the routing
  // does not know, or a `diagnosis` key, and both end up in front of a clinician
  // who has no way to tell the model wrote them.
  const parsed = triageSummarySchema.safeParse(reply);
  return parsed.success ? parsed.data : null;
}
