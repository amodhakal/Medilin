import { MAX_HOUSEHOLD_SIZE } from "@/i18n/registry";
import type { Dependent } from "@/lib/validation/intake";

/**
 * Household booking on the client side (#69).
 *
 * The form is a client component, so everything that decides what a dependent's
 * input is called, and when the "add another person" button stops offering a
 * card, lives here rather than in the JSX. That is not tidiness: those are rules
 * a patient only discovers by being wrong, and a rule that can be tested
 * directly is a rule that does not need a browser to trust.
 *
 * The naming convention is the whole design. A dependent's input is called
 * `dependents.<index>.<field>`, and that one string is three things at once:
 *
 *   - the input's `name`, which is what the FormData reader scans for;
 *   - the DOM id it is linked to from the error summary, after the dots become
 *     dashes;
 *   - the path a Zod issue arrives on, because `["dependents", 1, "dob"]` joined
 *     with dots is exactly `dependents.1.dob`.
 *
 * One convention, so there is no second table that can disagree about which
 * message belongs to which control, and a rejection on the second person's card
 * cannot land on the first person's date input.
 */

const DEPENDENT_FIELD = /^dependents\.(0|[1-9]\d*)\.(firstName|lastName|dob|relationship|additionalInfo)$/;

/** The fields a dependent's card has, in the order it renders them. */
export const DEPENDENT_FIELDS = [
  "firstName",
  "lastName",
  "dob",
  "relationship",
  "additionalInfo",
] as const;

export type DependentFieldName = (typeof DEPENDENT_FIELDS)[number];

/**
 * A field addressed by whose card it is on.
 *
 * The template literal type, so `dependents.0.dob` is a `DependentFieldKey` and
 * `errorId`/`fieldId` will take it without a cast at the call site. A helper
 * that returned a bare `string` would push that cast into the form and, with it,
 * the possibility of attaching a message to a name no control has.
 */
export type DependentFieldKey = `dependents.${number}.${DependentFieldName}`;

/** A field name that is known to be one a dependent has. */
export function isDependentFieldName(value: string): value is DependentFieldName {
  return (DEPENDENT_FIELDS as readonly string[]).includes(value);
}

/** The `name` of one field on one person's card. */
export function dependentFieldName(
  index: number,
  field: DependentFieldName,
): DependentFieldKey {
  return `dependents.${index}.${field}`;
}

/**
 * Read a name back into the person and the field it belongs to.
 *
 * Null for anything that is not exactly the shape `dependentFieldName` produces.
 * That includes the primary patient's own fields, an inherited `Object` member,
 * and a path with a field no dependent has -- all of which are a server and
 * client disagreement, and none of which may be rendered next to a control.
 */
export function parseDependentField(
  name: string,
): { index: number; field: DependentFieldName } | null {
  const match = DEPENDENT_FIELD.exec(name);
  if (!match) return null;

  return { index: Number(match[1]), field: match[2] as DependentFieldName };
}

/** How many other people the booking currently carries. */
export function householdSize(dependents: readonly Dependent[] | undefined): number {
  return dependents?.length ?? 0;
}

/**
 * The size after adding one person, or null when there is no room.
 *
 * `max` defaults to the registry's copy of the cap rather than the server's
 * `MAX_DEPENDENTS`, for the same reason `DEPARTMENT_OPTIONS` holds literal
 * values: a client bundle has no business importing a module to read a number
 * out of a zod schema. registry.test.ts holds the two equal.
 *
 * Null rather than a clamped number so the caller cannot render a button that
 * does nothing. The cap is enforced here as well as in the schema on purpose:
 * the schema refusing a sixth card after someone has filled it in is correct
 * but late, and a form that takes four minutes of a parent's time before saying
 * no is a bad experience of the same rule.
 */
export function nextHouseholdSize(
  current: number,
  max: number = MAX_HOUSEHOLD_SIZE,
): number | null {
  return current >= max ? null : current + 1;
}

/**
 * How many people a booking of this many other people is for.
 *
 * The account holder is always one of them, which is the fact a confirmation and
 * a "Person 2" heading both need and the two must not each have their own copy
 * of. `summariseHousehold` below is this over a record's array; the form has a
 * count rather than an array, because the cards hold no values of their own.
 */
export function peopleCount(others: number): number {
  return others + 1;
}

/** How many people the booking is for, counting the account holder. */
export function summariseHousehold(dependents: readonly Dependent[] | undefined): number {
  return peopleCount(householdSize(dependents));
}
