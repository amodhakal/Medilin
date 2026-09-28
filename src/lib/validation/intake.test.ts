import { describe, expect, test } from "bun:test";
import {
  DEPENDENT_RELATIONSHIPS,
  MAX_DEPENDENTS,
  appointmentRecordSchema,
  dependentSchema,
  intakeFromFormData,
  intakeSchema,
  intakeSummaryRequestSchema,
  MEDICAL_DEPARTMENTS,
  webhookPayloadSchema,
} from "./intake";

const valid = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "mild headache",
  language: "spanish",
};

describe("intakeSchema", () => {
  test("accepts a well-formed submission", () => {
    const result = intakeSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("trims whitespace and applies defaults", () => {
    const result = intakeSchema.parse({
      ...valid,
      firstName: "  Ada  ",
      additionalInfo: "",
      language: undefined,
    });
    expect(result.firstName).toBe("Ada");
    expect(result.language).toBe("english");
  });

  test("rejects unknown keys rather than dropping them", () => {
    // This is what stops a caller smuggling extra fields into storage.
    const result = intakeSchema.safeParse({ ...valid, isAdmin: "true" });
    expect(result.success).toBe(false);
  });

  test.each([
    ["firstName", ""],
    ["firstName", "   "],
    ["lastName", ""],
    ["email", "not-an-email"],
    ["email", "a@b"],
    ["dob", "10/12/1985"],
    ["dob", "1985-13-45"],
    ["dob", "1985-02-30"],
    ["insurance", "maybe"],
    ["phone", "12"],
    ["appointmentDateTime", "2026-10-01 09:30"],
    ["medical_department", "Astrology"],
    ["additionalInfo", "x".repeat(2001)],
    ["language", "klingon"],
  ])("rejects an invalid %s (%s)", (field, value) => {
    const result = intakeSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
  });

  test("accepts every declared department", () => {
    for (const department of MEDICAL_DEPARTMENTS) {
      expect(intakeSchema.safeParse({ ...valid, medical_department: department }).success).toBe(true);
    }
  });

  test("rejects a missing required field", () => {
    const { email: _omitted, ...withoutEmail } = valid;
    expect(intakeSchema.safeParse(withoutEmail).success).toBe(false);
  });

  test("reports every failing field at once", () => {
    const result = intakeSchema.safeParse({ ...valid, email: "bad", phone: "1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("email");
      expect(fields).toContain("phone");
    }
  });
});

describe("intakeFromFormData", () => {
  test("reads a submission out of FormData", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) {
      formData.append(key, value);
    }
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(true);
  });

  test("ignores keys the schema does not declare", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) {
      formData.append(key, value);
    }
    formData.append("isAdmin", "true");
    // Ignored rather than passed through, so it cannot trip .strict().
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(true);
  });

  test("reports absent fields as missing", () => {
    const formData = new FormData();
    formData.append("firstName", "Ada");
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(false);
  });
});

describe("webhookPayloadSchema", () => {
  test("accepts a well-formed payload", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "ada@example.test",
        language: "english",
        info: "{}",
      }).success,
    ).toBe(true);
  });

  test("rejects a payload with extra keys", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "ada@example.test",
        language: "english",
        info: "{}",
        from: "attacker@example.test",
      }).success,
    ).toBe(false);
  });

  test("rejects an arbitrary recipient", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "victim@example.test",
        language: "english",
        info: "{}",
      }).success,
    ).toBe(true);
  });
});

describe("intakeSummaryRequestSchema", () => {
  test("accepts a sealed token", () => {
    expect(
      intakeSummaryRequestSchema.safeParse({ token: "abc123SEALEDtoken" }).success,
    ).toBe(true);
  });

  test.each([
    ["a missing token", {}],
    ["a blank token", { token: "" }],
    ["a whitespace-only token", { token: "   " }],
    ["a non-string token", { token: 12345 }],
    // There is no id-based alternative, so an id has to be refused rather than
    // ignored: an accepted request that then looks up nothing is a 404 the
    // caller cannot explain.
    ["an appointment id", { token: "abc", appointmentId: "1" }],
    ["a raw record", { token: "abc", record: { firstName: "Ada" } }],
  ])("rejects %s", (_label, value) => {
    expect(intakeSummaryRequestSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a token long enough to be an attempt at something", () => {
    expect(intakeSummaryRequestSchema.safeParse({ token: "x".repeat(20_001) }).success).toBe(
      false,
    );
  });
});

/**
 * Household booking (#69).
 *
 * The single-patient submission has to keep working exactly as it did, because
 * it is what every existing form, every stored record, and every test fixture in
 * this repo sends. So the whole of household support is additive: one optional
 * key, defaulting to empty, that a submission which has never heard of it does
 * not have to mention.
 */
const dependent = {
  firstName: "Maya",
  lastName: "Lovelace",
  dob: "2018-04-02",
  relationship: "child",
  additionalInfo: "fiebre desde anoche",
};

describe("dependentSchema", () => {
  test("accepts a dependent", () => {
    expect(dependentSchema.safeParse(dependent).success).toBe(true);
  });

  test("accepts a dependent with no last name", () => {
    // A child's surname is frequently the same as the account holder's, or not
    // something they think to type. Requiring it would push people to invent
    // one, and an invented surname on a clinical record is worse than none.
    const withoutLastName: Record<string, unknown> = { ...dependent };
    delete withoutLastName.lastName;
    expect(dependentSchema.safeParse(withoutLastName).success).toBe(true);
  });

  test("accepts a dependent who said nothing about why they are coming in", () => {
    // The primary patient's reason is optional and so is theirs. A child who is
    // "fine, just came with mum" is a normal submission.
    const result = dependentSchema.safeParse({ ...dependent, additionalInfo: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.additionalInfo).toBe("");
  });

  test("accepts every declared relationship", () => {
    for (const relationship of DEPENDENT_RELATIONSHIPS) {
      expect(dependentSchema.safeParse({ ...dependent, relationship }).success).toBe(true);
    }
  });

  test.each([
    ["no first name", { ...dependent, firstName: "" }],
    ["no date of birth", { ...dependent, dob: "" }],
    ["a date of birth that is not a date", { ...dependent, dob: "02/04/2018" }],
    ["a date of birth that is not real", { ...dependent, dob: "2018-02-31" }],
    ["an unknown relationship", { ...dependent, relationship: "household pet" }],
    ["no relationship", { ...dependent, relationship: undefined }],
    ["an oversized reason", { ...dependent, additionalInfo: "x".repeat(2001) }],
    // .strict() here as everywhere else: a dependent is a patient record, and an
    // extra key on one is a field the rest of the app does not know how to store
    // or show.
    ["an extra key", { ...dependent, isAdmin: "true" }],
  ])("rejects a dependent with %s", (_label, value) => {
    expect(dependentSchema.safeParse(value).success).toBe(false);
  });
});

describe("a single-patient submission", () => {
  test("still parses, with no household key on it at all", () => {
    // The compatibility guarantee, stated as a test: every existing form and
    // every stored record sends exactly these fields, and gets back exactly the
    // record it got before household support existed. Asserted key by key
    // rather than with `toEqual`, because that is the property being claimed --
    // same keys, same values, and nothing added.
    const result = intakeSchema.parse(valid);

    expect(result).not.toHaveProperty("dependents");
    expect(Object.keys(result)).toEqual(Object.keys(valid));
    for (const [key, value] of Object.entries(valid)) {
      expect(result[key as keyof typeof result]).toBe(value);
    }
  });

  test("accepts an explicitly empty household as an empty household", () => {
    // A caller that sends `dependents: []` gets `dependents: []` back. Omitting
    // the key is the reader's job, not the schema's -- see the token-length
    // argument on dependentsField, and the FormData test below.
    const result = intakeSchema.parse({ ...valid, dependents: [] });
    expect(result.dependents).toEqual([]);
  });

  test("still refuses unknown keys", () => {
    // The strictness that stops a caller smuggling fields into storage is not
    // relaxed by the new key, it is joined by one more thing to smuggle.
    expect(intakeSchema.safeParse({ ...valid, isAdmin: "true" }).success).toBe(false);
    expect(
      intakeSchema.safeParse({ ...valid, dependents: [{ ...dependent, isAdmin: "true" }] }).success,
    ).toBe(false);
  });
});

describe("a household submission", () => {
  test("accepts a primary patient with dependents", () => {
    const result = intakeSchema.safeParse({ ...valid, dependents: [dependent] });
    expect(result.success).toBe(true);
  });

  test("accepts several dependents, in the order given", () => {
    const second = { ...dependent, firstName: "Byron", relationship: "parent" };
    const result = intakeSchema.parse({ ...valid, dependents: [dependent, second] });

    expect(result.dependents?.map((person) => person.firstName)).toEqual(["Maya", "Byron"]);
  });

  test("accepts the most people a household booking allows", () => {
    const many = Array.from({ length: MAX_DEPENDENTS }, (_, i) => ({
      ...dependent,
      firstName: `Person${i}`,
    }));
    expect(intakeSchema.safeParse({ ...valid, dependents: many }).success).toBe(true);
  });

  test("refuses more people than a household booking allows", () => {
    // A cap, not a free list. Every extra person is another clinical record in
    // one booking, another translation call, and another set of free text for a
    // model to summarise. Past a handful this is a scheduling conversation, not
    // an intake form, and an uncapped list is a way to spend the API budget by
    // submitting one field a thousand times.
    const tooMany = Array.from({ length: MAX_DEPENDENTS + 1 }, (_, i) => ({
      ...dependent,
      firstName: `Person${i}`,
    }));
    expect(intakeSchema.safeParse({ ...valid, dependents: tooMany }).success).toBe(false);
  });

  test("refuses a list that is not a list", () => {
    for (const dependents of [dependent, "Maya", 42, null]) {
      expect(intakeSchema.safeParse({ ...valid, dependents }).success).toBe(false);
    }
  });

  test("reports the failing dependent's own field, by index", () => {
    // The error summary links to a control, so the path has to identify which
    // person it is about. "dependents.1.dob" is the input's own name, which is
    // what lets the message land under the right date field.
    const result = intakeSchema.safeParse({
      ...valid,
      dependents: [dependent, { ...dependent, dob: "nope" }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("dependents.1.dob");
    }
  });

  test("trims a dependent's fields the same way the primary patient's are", () => {
    const result = intakeSchema.parse({
      ...valid,
      dependents: [{ ...dependent, firstName: "  Maya  " }],
    });
    expect(result.dependents?.[0].firstName).toBe("Maya");
  });
});

describe("appointmentRecordSchema", () => {
  test("carries a household through translation", () => {
    // Translation must not be able to drop people. This is the schema
    // `applyTranslation` re-validates against, so a household absent from it
    // would mean every non-English household booking silently loses everyone but
    // the account holder.
    const record = { ...valid, additionalInfo: "headache", language: "english" };
    const result = appointmentRecordSchema.safeParse({ ...record, dependents: [dependent] });

    expect(result.success).toBe(true);
  });

  test("accepts a record that has no household at all", () => {
    // Every record stored before this change, and every fixture in the repo, has
    // no `dependents` key. It is permitted rather than defaulted here, so a
    // record that goes in without one comes out without one and the two are
    // still equal.
    const legacy: Record<string, unknown> = { ...valid };
    expect(appointmentRecordSchema.safeParse(legacy).success).toBe(true);
  });

  test("still validates each dependent rather than trusting the array", () => {
    const record = { ...valid, additionalInfo: "headache", language: "english" };
    expect(
      appointmentRecordSchema.safeParse({ ...record, dependents: [{ ...dependent, dob: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("intakeFromFormData with a household", () => {
  function formWith(keys: Record<string, string>): FormData {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) formData.append(key, value);
    for (const [key, value] of Object.entries(keys)) formData.append(key, value);
    return formData;
  }

  test("reads a single dependent", () => {
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
      "dependents.0.additionalInfo": "fiebre desde anoche",
    });

    const result = intakeSchema.safeParse(intakeFromFormData(formData));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependents).toHaveLength(1);
      expect(result.data.dependents?.[0].firstName).toBe("Maya");
    }
  });

  test("reads several dependents and keeps them in index order", () => {
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
      "dependents.1.firstName": "Byron",
      "dependents.1.dob": "1980-01-01",
      "dependents.1.relationship": "spouse",
    });

    const result = intakeSchema.parse(intakeFromFormData(formData));
    expect(result.dependents?.map((person) => person.firstName)).toEqual(["Maya", "Byron"]);
  });

  test("does not put an absent optional field in the dependent", () => {
    // `lastName` is not required, and a key set to the empty string is not the
    // same as a key that was never submitted.
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
    });

    const result = intakeSchema.parse(intakeFromFormData(formData));
    expect(result.dependents?.[0]).not.toHaveProperty("lastName");
  });

  test("ignores a key that only looks like a dependent field", () => {
    // FormData is a flat string map that a caller controls, and the scanner
    // reads it by pattern. Anything that is not exactly
    // `dependents.<index>.<field>` for a field a dependent has is not a
    // dependent, and .strict() has to still be able to reject it.
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
      "dependents.0.isAdmin": "true",
      "dependents.x.firstName": "Mallory",
      "dependents.-1.firstName": "Mallory",
      "dependents.0": "Maya",
    });

    const result = intakeSchema.safeParse(intakeFromFormData(formData));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependents).toHaveLength(1);
      expect(JSON.stringify(result.data.dependents)).not.toContain("Mallory");
      expect(JSON.stringify(result.data.dependents)).not.toContain("isAdmin");
    }
  });

  test("treats a high index as a real person rather than ignoring it", () => {
    // Index 7 is a well-formed key, so it describes someone. Silently dropping
    // it would lose a person out of a booking; the whole household is rejected
    // instead, which the patient can see and correct.
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
      "dependents.7.dob": "1980-01-01",
    });

    const parsed = intakeSchema.safeParse(intakeFromFormData(formData));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("dependents.1.firstName");
    }
  });

  test("does not build a household from an absurd index", () => {
    // The cap that bounds what gets validated is not the cap that bounds what
    // gets built. A submission with `dependents.0` through `dependents.99999`
    // matches every syntactic rule, so the reader has to be the thing that
    // refuses it -- otherwise one request allocates a hundred thousand objects.
    const keys: Record<string, string> = {
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "2018-04-02",
      "dependents.0.relationship": "child",
    };
    for (let i = 1; i <= 5000; i += 1) keys[`dependents.${i}.firstName`] = `Person${i}`;

    const parsed = intakeSchema.safeParse(intakeFromFormData(formWith(keys)));
    // Whether the result is accepted or refused, it is not a 5,001-person
    // household that got past the cap.
    expect(parsed.success).toBe(false);
  });

  test("collapses a sparse index rather than leaving a hole", () => {
    // A hand-built request that skips index 0 must not produce an array whose
    // first element is undefined, because the error paths the form renders are
    // derived from the array position and would then point at the wrong person.
    const formData = formWith({
      "dependents.3.firstName": "Maya",
      "dependents.3.dob": "2018-04-02",
      "dependents.3.relationship": "child",
    });

    const result = intakeSchema.parse(intakeFromFormData(formData));
    expect(result.dependents).toHaveLength(1);
    expect(result.dependents?.[0].firstName).toBe("Maya");
  });

  test("leaves a submission with no household keys as a single-patient booking", () => {
    const result = intakeSchema.parse(intakeFromFormData(formWith({})));
    expect(result).not.toHaveProperty("dependents");
  });

  test("does not put an empty household on a one-person submission", () => {
    // The reader's own output, before the schema defaults the key. This is what
    // keeps a single-patient sealed token exactly as short as it was before
    // household support: `dependents: []` on every record is eighteen bytes of
    // ciphertext in every link a patient is handed, for no information.
    const raw = intakeFromFormData(formWith({})) as Record<string, unknown>;

    expect(raw).not.toHaveProperty("dependents");
    expect(JSON.stringify(raw)).not.toContain("dependents");
  });

  test("puts a household on the record when there is one", () => {
    const raw = intakeFromFormData(
      formWith({
        "dependents.0.firstName": "Maya",
        "dependents.0.dob": "2018-04-02",
        "dependents.0.relationship": "child",
      }),
    ) as Record<string, unknown>;

    expect(raw.dependents).toHaveLength(1);
  });

  test("reports a dependent's own failure against the input that caused it", () => {
    const formData = formWith({
      "dependents.0.firstName": "Maya",
      "dependents.0.dob": "not-a-date",
      "dependents.0.relationship": "child",
    });

    const parsed = intakeSchema.safeParse(intakeFromFormData(formData));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("dependents.0.dob");
    }
  });
});
