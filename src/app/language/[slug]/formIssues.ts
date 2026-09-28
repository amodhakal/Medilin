import {
  DEPENDENT_FIELD_LABELS,
  DEPENDENT_FIELDS,
  FIELD_LABELS,
  formatMessage,
  type IntakeFieldName,
  type MessageKey,
  type Messages,
} from "@/i18n/registry";
import type { FieldIssue } from "@/lib/validation/parse";
import {
  parseDependentField,
  type DependentFieldName,
} from "./household";

/**
 * Turning server validation results into something a form can render.
 *
 * `submitIntakeForm` reports problems as `{ field, message }` pairs, where
 * `field` is the input's `name`. The form needs three things out of that: a
 * message to put under the offending control, a way to mark that control
 * invalid for a screen reader, and a list for the summary a patient is sent to
 * when something is wrong. The old form showed `result.error` in a toast and
 * nothing else, so a rejected submission told a patient that it had failed
 * without saying which of the ten fields had.
 *
 * The messages themselves come from the server and are in English. They are not
 * invented here: inventing a localized string per Zod rule would mean a second
 * message catalogue that could disagree with the first, in a form that already
 * has a translation registry. What is localized is the field name in the
 * summary, which is the part a patient has to match up with the field on
 * screen.
 *
 * Household booking added a second kind of field name to understand:
 * `dependents.1.dob` is the date of birth on the *second* person's card, and it
 * is a name this module has to recognise as belonging to a control rather than
 * report as a field the form does not have. The alternative -- dropping those
 * issues into `unattached` -- is the failure the whole naming scheme exists to
 * prevent: a parent being told "check these fields" with no way to tell which
 * child needs fixing.
 */

/** A field on the account holder's own part of the form. */
export type PrimaryFieldName = IntakeFieldName;

/** A field on one person's card, addressed by position. */
export type DependentFieldKey = `dependents.${number}.${DependentFieldName}`;

/** Anything this form can put a message under. */
export type FormFieldKey = PrimaryFieldName | DependentFieldKey;

export type FieldErrors = Partial<Record<FormFieldKey, string>>;

export interface CollectedIssues {
  /** First message per known field. */
  byField: FieldErrors;
  /**
   * Issues that name no field this form has, or repeat a field that already
   * has a message. Kept rather than dropped: a server-side problem the form
   * cannot place belongs in front of the patient, not in a log they cannot
   * see.
   */
  unattached: string[];
}

/** Whether this form has a control by this name. */
function isFormField(name: string): name is FormFieldKey {
  return Object.hasOwn(FIELD_LABELS, name) || parseDependentField(name) !== null;
}

/**
 * The DOM id of a field's input, for summary links.
 *
 * Dots become dashes. A `dependents.1.dob` id is not a legal, or at least not a
 * sane, CSS or `getElementById` handle to hand to an `href` fragment, and the
 * index in the middle is what keeps one person's date of birth from sharing an
 * id with another's.
 */
export function fieldId(field: FormFieldKey): string {
  return field.replaceAll(".", "-");
}

/** The DOM id of a field's error message, for aria-describedby. */
export function errorId(field: FormFieldKey): string {
  return `${fieldId(field)}-error`;
}

export function collectIssues(issues: readonly FieldIssue[]): CollectedIssues {
  const byField: FieldErrors = {};
  const unattached: string[] = [];

  for (const issue of issues) {
    if (!isFormField(issue.field)) {
      unattached.push(issue.message);
      continue;
    }

    if (byField[issue.field] === undefined) {
      byField[issue.field] = issue.message;
    }
  }

  return { byField, unattached };
}

export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * One entry per problem, for the summary: the field's localized name, the
 * message, and where to jump to.
 */
export interface SummaryEntry {
  field: FormFieldKey;
  label: string;
  message: string;
  href: string;
}

/**
 * What a patient's own part of the form calls a field, in the order it shows
 * them.
 *
 * `FIELD_LABELS` key order rather than `INTAKE_FIELDS`, because that is what it
 * was before household support and the two are in the same order today; a
 * household field is not in it at all and sorts last, under the group.
 */
const PRIMARY_ORDER = Object.keys(FIELD_LABELS);

/**
 * A dependent's field, named for who it belongs to.
 *
 * "Date of birth" appears once per card, and a summary listing it three times
 * with nothing to tell the cards apart is not something a parent can act on, so
 * the person is part of the label.
 */
function dependentLabel(
  field: DependentFieldKey,
  messages: Messages,
): string {
  const parsed = parseDependentField(field);
  /* istanbul ignore next -- callers only pass fields that parsed. */
  if (!parsed) return field;

  const person = formatMessage(messages.personHeading, { number: parsed.index + 1 });
  const label: MessageKey = DEPENDENT_FIELD_LABELS[parsed.field];

  return `${person} — ${messages[label]}`;
}

/**
 * Where a field sits in the form, as a single number.
 *
 * Sorting on one number rather than in two passes so that a submission with an
 * error on the account holder and on the third person reads top to bottom the
 * way the page does, rather than grouping the errors by who they are about.
 */
function fieldOrder(field: FormFieldKey): number {
  const primary = PRIMARY_ORDER.indexOf(field);
  if (primary !== -1) return primary;

  // Everything household is after every primary field, then by person, then by
  // the order the card renders its inputs in.
  const parsed = parseDependentField(field);
  /* istanbul ignore next -- only reached for a key that is a primary or a dependent. */
  if (!parsed) return Number.MAX_SAFE_INTEGER;

  return (
    PRIMARY_ORDER.length +
    parsed.index * DEPENDENT_FIELDS.length +
    DEPENDENT_FIELDS.indexOf(parsed.field)
  );
}

export function summaryEntries(
  errors: FieldErrors,
  messages: Messages,
): SummaryEntry[] {
  return Object.entries(errors)
    .map(([field, message]) => {
      const name = field as FormFieldKey;
      return {
        field: name,
        label: parseDependentField(name)
          ? dependentLabel(name as DependentFieldKey, messages)
          : messages[FIELD_LABELS[name as IntakeFieldName]],
        message: message ?? "",
        href: `#${fieldId(name)}`,
      };
    })
    .sort((a, b) => fieldOrder(a.field) - fieldOrder(b.field));
}
