import {
  FIELD_LABELS,
  type IntakeFieldName,
  type MessageKey,
  type Messages,
} from "@/i18n/registry";
import type { FieldIssue } from "@/lib/validation/parse";

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
 */

export type FieldErrors = Partial<Record<IntakeFieldName, string>>;

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

/** The DOM id of a field's error message, for aria-describedby. */
export function errorId(field: IntakeFieldName): string {
  return `${field}-error`;
}

/** The DOM id of a field's input, for summary links. */
export function fieldId(field: IntakeFieldName): string {
  return field;
}

export function collectIssues(issues: readonly FieldIssue[]): CollectedIssues {
  const byField: FieldErrors = {};
  const unattached: string[] = [];

  for (const issue of issues) {
    const field = issue.field as IntakeFieldName;
    const known = Object.hasOwn(FIELD_LABELS, field);

    if (!known) {
      unattached.push(issue.message);
      continue;
    }

    if (byField[field] === undefined) {
      byField[field] = issue.message;
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
  field: IntakeFieldName;
  label: string;
  message: string;
  href: string;
}

export function summaryEntries(
  errors: FieldErrors,
  messages: Messages,
): SummaryEntry[] {
  return Object.entries(errors)
    .map(([field, message]) => {
      const name = field as IntakeFieldName;
      const labelKey: MessageKey = FIELD_LABELS[name];
      return {
        field: name,
        label: messages[labelKey],
        message: message ?? "",
        href: `#${fieldId(name)}`,
      };
    })
    .sort(
      (a, b) =>
        Object.keys(FIELD_LABELS).indexOf(a.field) -
        Object.keys(FIELD_LABELS).indexOf(b.field),
    );
}
