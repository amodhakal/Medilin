import { describe, expect, test } from "bun:test";

import {
  FIELD_LABELS,
  INTAKE_FIELDS,
  LIVE_LANGUAGE_SLUGS,
  messagesFor,
} from "@/i18n/registry";
import { intakeSchema } from "@/lib/validation/intake";
import { describe as describeIssues } from "@/lib/validation/parse";
import {
  collectIssues,
  errorId,
  fieldId,
  hasFieldErrors,
  summaryEntries,
} from "./formIssues";

/**
 * The form's rendering of a server validation failure. The messages come from
 * the server, so what is worth testing is the mapping: a field name in an issue
 * has to become a message under the right control, and an issue naming a field
 * the form does not have must not be attached to one that it does.
 */

const english = messagesFor("english");

function issuesFrom(raw: Record<string, unknown>) {
  const parsed = intakeSchema.safeParse(raw);
  if (parsed.success) throw new Error("fixture is supposed to be invalid");
  return describeIssues(parsed.error);
}

const validIntake = {
  firstName: "Jordan",
  lastName: "Reyes",
  email: "jordan.reyes@example.com",
  dob: "1980-04-01",
  insurance: "yes",
  phone: "+15550192834",
  appointmentDateTime: "2030-01-02T09:00",
  medical_department: "Doctor",
  additionalInfo: "",
};

describe("collectIssues", () => {
  test("puts each message on the field the server named", () => {
    const collected = collectIssues([
      { field: "email", message: "Enter a valid email address" },
      { field: "dob", message: "Enter a real date" },
    ]);

    expect(collected.byField.email).toBe("Enter a valid email address");
    expect(collected.byField.dob).toBe("Enter a real date");
    expect(collected.unattached).toEqual([]);
  });

  test("keeps the first message when a field fails more than once", () => {
    const collected = collectIssues([
      { field: "email", message: "Enter a valid email address" },
      { field: "email", message: "Too long" },
    ]);

    expect(collected.byField.email).toBe("Enter a valid email address");
  });

  test("does not attach an issue to a field the form does not have", () => {
    // A renamed or removed input on the server, or a root-level problem. The
    // old rendering put the message under whatever control came next.
    const collected = collectIssues([
      { field: "(root)", message: "The form is malformed" },
      { field: "nhsNumber", message: "Unknown field" },
    ]);

    expect(collected.byField).toEqual({});
    expect(collected.unattached).toEqual(["The form is malformed", "Unknown field"]);
  });

  test("does not attach an issue that names an inherited Object member", () => {
    const collected = collectIssues([{ field: "constructor", message: "nope" }]);
    expect(collected.byField).toEqual({});
    expect(collected.unattached).toEqual(["nope"]);
  });

  test("separates real issues from a server-wide failure", () => {
    const collected = collectIssues(issuesFrom({ ...validIntake, email: "nope" }));

    expect(collected.byField.email).toBeTruthy();
    expect(collected.unattached).toEqual([]);
  });

  test("is empty for a clean submission", () => {
    const collected = collectIssues([]);
    expect(collected.byField).toEqual({});
    expect(collected.unattached).toEqual([]);
    expect(hasFieldErrors(collected.byField)).toBe(false);
  });
});

describe("summaryEntries", () => {
  test("names each failing field in the reader's language", () => {
    const entries = summaryEntries(
      { email: "Enter a valid email address" },
      messagesFor("spanish"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Correo Electrónico");
    expect(entries[0].message).toBe("Enter a valid email address");
  });

  test("links each entry to the control it is about", () => {
    const entries = summaryEntries({ email: "bad" }, english);
    expect(entries[0].href).toBe(`#${fieldId("email")}`);
  });

  test("is in the order the form shows the fields, not the order they failed", () => {
    const entries = summaryEntries(
      { medical_department: "bad", firstName: "bad", email: "bad" },
      english,
    );

    expect(entries.map((entry) => entry.field)).toEqual([
      "firstName",
      "email",
      "medical_department",
    ]);
  });

  test("labels the department field with its localized name, not its field name", () => {
    const entries = summaryEntries({ medical_department: "bad" }, english);
    expect(entries[0].label).toBe("Medical Department");
  });

  test("has a label for every language it could be rendered in", () => {
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      for (const field of INTAKE_FIELDS) {
        const [entry] = summaryEntries({ [field]: "bad" }, messagesFor(slug));
        expect(entry.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("is empty when nothing failed", () => {
    expect(summaryEntries({}, english)).toEqual([]);
  });
});

describe("field wiring", () => {
  test("every field label is a real message", () => {
    for (const [field, messageKey] of Object.entries(FIELD_LABELS)) {
      expect(messagesFor("english")[messageKey].trim().length).toBeGreaterThan(0);
      expect(field.trim().length).toBeGreaterThan(0);
    }
  });

  test("the error element id is unique per field and derived from the input id", () => {
    const ids = INTAKE_FIELDS.map((field) => errorId(field));
    expect(new Set(ids).size).toBe(ids.length);
    for (const field of INTAKE_FIELDS) {
      expect(errorId(field)).toBe(`${fieldId(field)}-error`);
    }
  });

  test("covers every field the intake schema accepts that a patient types into", () => {
    const typed: string[] = Object.keys(intakeSchema.shape).filter(
      (key) => key !== "language",
    );
    const fields: string[] = [...INTAKE_FIELDS];
    expect(fields.sort()).toEqual(typed.sort());
    expect(Object.keys(FIELD_LABELS).sort()).toEqual(typed.sort());
  });
});
