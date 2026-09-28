import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DEPENDENT_RELATIONSHIPS, MAX_DEPENDENTS } from "@/lib/validation/intake";
import { formatMessage, messagesFor } from "@/i18n/registry";
import { intakeSchema, type Dependent } from "@/lib/validation/intake";
import { describe as describeIssues } from "@/lib/validation/parse";
import {
  collectIssues,
  errorId,
  fieldId,
  hasFieldErrors,
  summaryEntries,
} from "./formIssues";
import {
  DEPENDENT_FIELDS,
  dependentFieldName,
  householdSize,
  nextHouseholdSize,
  parseDependentField,
  peopleCount,
  summariseHousehold,
} from "./household";
import { BookingConfirmation } from "./BookingConfirmation";
import { DependentCard } from "./IntakeForm";

/**
 * The household half of the intake form.
 *
 * The form is a client component, so the rules worth testing are the ones that
 * would otherwise only be observable by filling in a browser: what an input is
 * called, which one a server error belongs to, and whether the "add another
 * person" button ever offers a sixth card.
 *
 * The naming is the load-bearing part. A dependent's input is
 * `dependents.<index>.<field>` and that string is simultaneously the input's
 * `name`, the DOM id it is linked to, and the path a Zod issue arrives on
 * (`["dependents", 1, "dob"]` joined with dots). One convention, so a message
 * under the wrong person's card cannot happen.
 */

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

const maya: Dependent = {
  firstName: "Maya",
  lastName: "Reyes",
  dob: "2018-04-02",
  relationship: "child",
  additionalInfo: "fever since last night",
};

describe("dependentFieldName", () => {
  test("names an input the way the schema's issue path does", () => {
    // The two strings are joined from the same idea, which is what lets
    // collectIssues match a message to a control with no lookup table.
    expect(dependentFieldName(0, "firstName")).toBe("dependents.0.firstName");
    expect(dependentFieldName(2, "dob")).toBe("dependents.2.dob");
  });

  test("round-trips through parseDependentField", () => {
    for (const field of DEPENDENT_FIELDS) {
      const name = dependentFieldName(3, field);
      expect(parseDependentField(name)).toEqual({ index: 3, field });
    }
  });

  test("gives every field on a card a distinct id", () => {
    const ids = DEPENDENT_FIELDS.map((field) => fieldId(dependentFieldName(0, field)));
    expect(new Set(ids).size).toBe(DEPENDENT_FIELDS.length);
  });

  test("gives two people different ids for the same field", () => {
    // Two inputs with the same id is a label pointing at the wrong control and
    // an error message announced against the wrong person.
    expect(fieldId(dependentFieldName(0, "dob"))).not.toBe(fieldId(dependentFieldName(1, "dob")));
  });
});

describe("parseDependentField", () => {
  test("reads a name the form produced", () => {
    expect(parseDependentField("dependents.0.dob")).toEqual({ index: 0, field: "dob" });
    expect(parseDependentField("dependents.12.relationship")).toEqual({
      index: 12,
      field: "relationship",
    });
  });

  test.each([
    "firstName",
    "dependents.dob",
    "dependents.x.dob",
    "dependents.-1.dob",
    "dependents.01.dob",
    "dependents.0.isAdmin",
    "dependents.0.",
    "dependents.0.dob.extra",
    "dependents.0",
    "",
    "constructor",
    "__proto__",
    "toString",
  ])("rejects %p", (name) => {
    expect(parseDependentField(name)).toBeNull();
  });

  test("does not mistake a primary field for a dependent one", () => {
    for (const field of ["email", "additionalInfo", "medical_department"]) {
      expect(parseDependentField(field)).toBeNull();
    }
  });
});

describe("household size", () => {
  test("starts at nobody", () => {
    expect(householdSize(undefined)).toBe(0);
    expect(householdSize([])).toBe(0);
  });

  test("counts what is there", () => {
    expect(householdSize([maya])).toBe(1);
    expect(householdSize([maya, { ...maya, firstName: "Byron" }])).toBe(2);
  });

  test("offers another card only while there is room", () => {
    expect(nextHouseholdSize(0)).toBe(1);
    expect(nextHouseholdSize(MAX_DEPENDENTS - 1)).toBe(MAX_DEPENDENTS);
    // The boundary is the point. A form that lets a patient build a seventh card
    // and only then refuses it is a form that takes four minutes of someone's
    // time before telling them no.
    expect(nextHouseholdSize(MAX_DEPENDENTS)).toBeNull();
    expect(nextHouseholdSize(MAX_DEPENDENTS + 10)).toBeNull();
  });

  test("treats an over-long list as full rather than as an error", () => {
    // Only reachable by a state bug, but "cannot add" is the right answer and
    // `null` is the only one the button understands.
    const tooMany = Array.from({ length: MAX_DEPENDENTS + 3 }, () => maya);
    expect(nextHouseholdSize(householdSize(tooMany))).toBeNull();
  });
});

describe("issues from a household submission", () => {
  function issuesFrom(dependents: unknown[]) {
    const parsed = intakeSchema.safeParse({ ...validIntake, dependents });
    if (parsed.success) throw new Error("fixture is supposed to be invalid");
    return describeIssues(parsed.error);
  }

  test("puts a dependent's error on that dependent's own control", () => {
    const collected = collectIssues(issuesFrom([{ ...maya, dob: "not-a-date" }]));

    expect(collected.byField["dependents.0.dob"]).toBeTruthy();
    expect(collected.unattached).toEqual([]);
  });

  test("keeps each person's error on their own card", () => {
    // The failure this whole naming scheme exists to prevent: one child's error
    // rendered on another child's field.
    const collected = collectIssues(
      issuesFrom([maya, { ...maya, firstName: "", relationship: "nope" }]),
    );

    expect(collected.byField["dependents.1.firstName"]).toBeTruthy();
    expect(collected.byField["dependents.1.relationship"]).toBeTruthy();
    expect(collected.byField["dependents.0.firstName"]).toBeUndefined();
    expect(collected.byField["dependents.0.relationship"]).toBeUndefined();
  });

  test("leaves a primary field's error where it was", () => {
    const collected = collectIssues(issuesFrom([{ ...maya, firstName: "" }]));

    expect(collected.byField["dependents.0.firstName"]).toBeTruthy();
    expect(hasFieldErrors(collected.byField)).toBe(true);
  });

  test("links a dependent's error to that person's date input", () => {
    const [entry] = summaryEntries(
      { "dependents.1.dob": "Enter a real date" },
      messagesFor("english"),
    );

    expect(entry.href).toBe(`#${fieldId("dependents.1.dob")}`);
    expect(entry.href).toBe("#dependents-1-dob");
  });

  test("names the person, not just the field", () => {
    // "Date of birth" twice in one summary, on two cards, tells the person
    // fixing the form which date to go and look at only if the summary says
    // whose it is.
    const entries = summaryEntries(
      { "dependents.0.dob": "Enter a real date", "dependents.1.dob": "Use YYYY-MM-DD" },
      messagesFor("english"),
    );

    expect(entries[0].label).toContain("Person 1");
    expect(entries[0].label).toContain("Date of Birth");
    expect(entries[1].label).toContain("Person 2");
  });

  test("orders the summary: the account holder first, then each person in order", () => {
    const entries = summaryEntries(
      {
        "dependents.1.dob": "bad",
        email: "bad",
        "dependents.0.firstName": "bad",
        "dependents.0.relationship": "bad",
      },
      messagesFor("english"),
    );

    expect(entries.map((entry) => entry.href)).toEqual([
      "#email",
      "#dependents-0-firstName",
      "#dependents-0-relationship",
      "#dependents-1-dob",
    ]);
  });

  test("orders two errors on the same card in the order the card shows them", () => {
    const entries = summaryEntries(
      { "dependents.0.relationship": "bad", "dependents.0.dob": "bad", "dependents.0.firstName": "bad" },
      messagesFor("english"),
    );

    expect(entries.map((entry) => entry.href)).toEqual([
      "#dependents-0-firstName",
      "#dependents-0-dob",
      "#dependents-0-relationship",
    ]);
  });

  test("labels a rejection of the household itself", () => {
    // Too many people, or a list that is not a list: there is no card to point
    // at, so the message goes on the group.
    const collected = collectIssues([
      { field: "dependents", message: "At most 5 other people" },
    ]);

    expect(collected.byField.dependents).toBe("At most 5 other people");
    const [entry] = summaryEntries(collected.byField, messagesFor("english"));
    expect(entry.label).toBe("Other people in this booking");
    expect(entry.href).toBe("#dependents");
  });

  test("still refuses to attach an issue naming something that is not a field", () => {
    // An inherited Object member, and a path that is a dependent's but for a
    // field it does not have. Both are a server and client disagreement, and
    // neither may be rendered next to a control.
    for (const field of ["constructor", "dependents.0.isAdmin", "dependents.dob", "dependents.0"]) {
      const collected = collectIssues([{ field, message: "nope" }]);
      expect(collected.byField).toEqual({});
      expect(collected.unattached).toEqual(["nope"]);
    }
  });

  test("translates a household error summary into every language", () => {
    for (const slug of ["english", "spanish", "portuguese"]) {
      const entries = summaryEntries(
        { "dependents.0.relationship": "bad", "dependents.0.dob": "bad" },
        messagesFor(slug),
      );

      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.label.trim().length).toBeGreaterThan(0);
        expect(entry.label).not.toBe("dependents.0.relationship");
      }
      // Every message in a household summary carries a person number, so the
      // "{number}" placeholder has to be filled in every language or a patient
      // reads a literal brace.
      expect(entries[0].label).not.toContain("{");
    }
  });

  test("gives a household field a message id that is unique across the page", () => {
    const ids = [
      ...DEPENDENT_FIELDS.map((field) => errorId(dependentFieldName(0, field))),
      ...DEPENDENT_FIELDS.map((field) => errorId(dependentFieldName(1, field))),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("peopleCount", () => {
  test("counts the account holder as one of the people", () => {
    expect(peopleCount(0)).toBe(1);
    expect(peopleCount(1)).toBe(2);
  });

  test("agrees with summariseHousehold, which reads a record rather than a count", () => {
    // Two ways of asking the same question -- one from the form's state, one
    // from the stored record -- and one answer between them.
    for (const count of [0, 1, 4]) {
      const cards = Array.from({ length: count }, () => maya);
      expect(peopleCount(count)).toBe(summariseHousehold(cards));
      expect(peopleCount(count)).toBe(summariseHousehold(count === 0 ? undefined : cards));
    }
  });
});

describe("summariseHousehold", () => {
  test("counts the people in the booking", () => {
    expect(summariseHousehold([maya])).toBe(2);
    expect(summariseHousehold([maya, maya])).toBe(3);
  });

  test("counts one for a single-patient booking", () => {
    // The case that has to keep reading the way it always did: a person booking
    // for themselves is not told they booked a household.
    expect(summariseHousehold([])).toBe(1);
    expect(summariseHousehold(undefined)).toBe(1);
  });
});

/**
 * The markup, rendered to a string.
 *
 * The naming convention is only worth anything if the inputs actually use it, and
 * a card that renders `name="dob"` is a card the server's error paths cannot
 * reach. That is a property of the JSX, so it is asserted against the JSX rather
 * than against the naming helpers the JSX calls.
 */
describe("a dependent's card", () => {
  function renderCard(
    index: number,
    errorFor: (i: number, f: (typeof DEPENDENT_FIELDS)[number]) => string | undefined = () => undefined,
    slug = "english",
  ) {
    return renderToStaticMarkup(
      <DependentCard
        index={index}
        onRemove={() => {}}
        messages={messagesFor(slug)}
        errorFor={errorFor as never}
      />,
    );
  }

  test("names every input the way the server addresses it", () => {
    const html = renderCard(0);

    for (const field of DEPENDENT_FIELDS) {
      expect(html).toContain(`name="dependents.0.${field}"`);
    }
  });

  test("numbers the inputs by the card's position, not its identity", () => {
    // The name is the array position, because that is what the array index in a
    // validation error path is. React reconciles on a separate key so removing a
    // card cannot move one person's text under another person's name.
    expect(renderCard(0)).toContain('name="dependents.0.dob"');
    expect(renderCard(2)).toContain('name="dependents.2.dob"');
  });

  test("gives each card's inputs ids the error summary can link to", () => {
    // `fieldId` in ./formIssues turns the dots into dashes; both sides have to
    // agree or the summary link goes nowhere.
    const html = renderCard(1);

    for (const field of DEPENDENT_FIELDS) {
      expect(html).toContain(`id="dependents-1-${field}"`);
    }
  });

  test("two cards never share an id", () => {
    const first = renderCard(0);
    const second = renderCard(1);
    const idsOf = (html: string) => [...html.matchAll(/id="(dependents-[^"]+)"/g)].map((m) => m[1]);

    for (const id of idsOf(second)) {
      expect(idsOf(first)).not.toContain(id);
    }
  });

  test("labels the card with which person it is, counting the account holder", () => {
    // The form's first card is the second person in the booking, so the number
    // starts at two. Off-by-one here is a card labelled "Person 1" whose fields
    // are `dependents.0.*`.
    expect(renderCard(0)).toContain("Person 2");
    expect(renderCard(1)).toContain("Person 3");
  });

  test("offers exactly the relationships the server accepts", () => {
    const html = renderCard(0);

    for (const relationship of DEPENDENT_RELATIONSHIPS) {
      expect(html).toContain(`value="${relationship}"`);
    }
    // The blank option is the one the server refuses, and it has to be there as
    // a placeholder rather than as a way to submit an empty relationship.
    expect(html).toContain('value=""');
  });

  test("renders in every bookable language, with its own labels", () => {
    for (const slug of ["english", "spanish", "portuguese"]) {
      const messages = messagesFor(slug);
      const html = renderCard(0, undefined, slug);

      expect(html).toContain(messages.dependentReason);
      expect(html).toContain(messages.dependentRelationship);
      expect(html).toContain(messages.dependentLastNameOptional);
      expect(html).toContain(messages.removePerson);
      expect(html).toContain("dependents.0.firstName");
    }
  });

  test("puts the server's message under the control it belongs to", () => {
    const html = renderCard(1, (i, field) =>
      i === 1 && field === "dob" ? "Enter a real date" : undefined,
    );

    expect(html).toContain("Enter a real date");
    // aria-describedby has to point at the element that now holds the message, or
    // a screen reader is told the field is invalid and not why.
    expect(html).toContain('id="dependents-1-dob-error"');
    expect(html).toMatch(/id="dependents-1-dob"[^>]*aria-invalid="true"/);
  });

  test("marks a card's field invalid and links its message", () => {
    const html = renderCard(0, (_i, field) =>
      field === "relationship" ? "Required" : undefined,
    );

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Required");
  });

  test("leaves a field with no error unmarked", () => {
    const html = renderCard(0);

    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  test("marks only the failing field, not the whole card", () => {
    const html = renderCard(0, (_i, field) => (field === "firstName" ? "Required" : undefined));

    // Exactly one control is invalid: marking the card would leave a parent
    // hunting through four fields for the one that is wrong.
    expect([...html.matchAll(/aria-invalid="true"/g)]).toHaveLength(1);
  });

  test("escapes what it is given", () => {
    const html = renderCard(0, (_i, field) =>
      field === "firstName" ? '<script>alert("x")</script>' : undefined,
    );

    expect(html).not.toContain("<script>");
  });

  test("does not require a surname, and says it is optional", () => {
    const html = renderCard(0);

    // The server accepts an absent one, so `required` here would block a
    // submission the server is happy to take.
    const lastName = /<input[^>]*name="dependents\.0\.lastName"[^>]*>/.exec(html)?.[0] ?? "";
    expect(lastName).not.toContain("required");
    expect(html).toContain(messagesFor("english").dependentLastNameOptional);
  });

  test("requires the fields the server requires", () => {
    const html = renderCard(0);
    for (const field of ["firstName", "dob", "relationship"]) {
      const tag = new RegExp(`<input[^>]*name="dependents\\.0\\.${field}"[^>]*>`).exec(html)?.[0]
        ?? new RegExp(`<select[^>]*name="dependents\\.0\\.${field}"[^>]*>`).exec(html)?.[0]
        ?? "";
      expect(tag).toContain("required");
    }
  });
});

describe("the confirmation, for a household", () => {
  function renderConfirmation(people?: number, slug = "english") {
    return renderToStaticMarkup(
      <BookingConfirmation
        url="/spectate/SEALED"
        appointmentId="6f1d2c3b-0000-4000-8000-000000000000"
        remaining={20}
        staying={false}
        onStay={() => {}}
        onResume={() => {}}
        messages={messagesFor(slug)}
        {...(people === undefined ? {} : { people })}
      />,
    );
  }

  const confirmed = (count: number, slug = "english") =>
    formatMessage(messagesFor(slug).householdConfirmed, { count });

  test("says nothing extra for a single-patient booking", () => {
    // The compatibility requirement, on the one surface a patient reads
    // immediately after booking: one person sees what they always saw.
    expect(renderConfirmation()).not.toContain(confirmed(1));
    expect(renderConfirmation(1)).not.toContain(confirmed(1));
  });

  test("tells a household how many people are booked", () => {
    const html = renderConfirmation(3);

    expect(html).toContain(confirmed(3));
    expect(html).toContain("3");
  });

  test("counts the account holder, so a card's first person is two", () => {
    // `people` is the total, not the number of dependents. Getting this wrong
    // tells a parent with one child that two people are booked when three are.
    expect(renderConfirmation(2)).toContain(confirmed(2));
    expect(renderConfirmation(2)).not.toContain(confirmed(3));
  });

  test("renders in every bookable language", () => {
    for (const slug of ["english", "spanish", "portuguese"]) {
      const messages = messagesFor(slug);
      const html = renderConfirmation(3, slug);

      expect(html).toContain(formatMessage(messages.householdConfirmed, { count: 3 }));
      expect(html).toContain("3");
      // The number is in the sentence in every language, and no language is
      // left showing the placeholder itself.
      expect(html).not.toContain("{count}");
    }
  });
});
