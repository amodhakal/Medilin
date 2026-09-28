import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LANGUAGE_SLUGS, getLanguage } from "@/i18n/registry";
import { BookingConfirmation } from "./BookingConfirmation";

/**
 * The success path, rendered to a string.
 *
 * The bug this branch fixes was not visible in a test because the confirmation
 * did not exist: `window.location` was assigned in the same tick as the success
 * toast, so the document was torn down before anything could be read. Now that
 * there is markup for the outcome, it can be checked without a browser, and
 * the things worth checking are the ones that are easy to break: that the link
 * is a real link in the page, that the redirect is visible and can be
 * declined, and that the token is not printed across the confirmation.
 */

const url = "http://localhost:3000/spectate/abc123SEALEDtoken";
const appointmentId = "6f1d2c3b-0000-4000-8000-000000000000";

function render(
  overrides: Partial<React.ComponentProps<typeof BookingConfirmation>> = {},
) {
  return renderToStaticMarkup(
    <BookingConfirmation
      url={url}
      appointmentId={appointmentId}
      remaining={20}
      staying={false}
      onStay={() => {}}
      onResume={() => {}}
      messages={getLanguage("english").messages}
      {...overrides}
    />,
  );
}

describe("booking confirmation", () => {
  test("links to the consultation with the sealed token", () => {
    expect(render()).toContain(`href="${url}"`);
  });

  test("shows the appointment reference", () => {
    const html = render();
    expect(html).toContain("Reference:");
    expect(html).toContain(appointmentId);
  });

  test("says the booking was made", () => {
    expect(render()).toContain("Your appointment is booked");
  });

  test("offers a way to decline the redirect", () => {
    const html = render();
    expect(html).toContain("Stay on this page");
    expect(html).toContain("<button");
  });

  test("offers a way to resume the redirect after declining it", () => {
    expect(render({ staying: true })).toContain("Go to the consultation automatically");
  });

  test("counts down, with the number in the sentence", () => {
    expect(render({ remaining: 7 })).toContain("in 7 seconds");
  });

  test("uses the singular countdown for the last second", () => {
    // "in 1 seconds" is the kind of detail that survives review because
    // nobody reads the last second of a countdown.
    expect(render({ remaining: 1 })).toContain("in one second");
    expect(render({ remaining: 1 })).not.toContain("1 seconds");
  });

  test("announces the redirect once instead of counting down into a screen reader", () => {
    const html = render();
    // The countdown line is hidden from assistive technology; the notice is
    // the one thing that gets read out.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("You will be taken to the voice consultation automatically");
  });

  test("keeps the token out of the visible text of the confirmation", () => {
    // It is a bearer credential for the patient's own record, so it belongs
    // behind a disclosure rather than printed across the page. It is still the
    // href of the call link: that is the link, and hiding it would defeat the
    // point of the link.
    const html = render();
    const beforeDisclosure = html.slice(0, html.indexOf("<details"));
    const visibleText = beforeDisclosure.replace(/<[^>]*>/g, "");

    expect(visibleText).not.toContain("SEALEDtoken");
    expect(visibleText).not.toContain("/spectate/");
    expect(html).toContain(`href="${url}"`);
  });

  test("escapes what it is given", () => {
    // Nothing patient-shaped reaches this component, but a token is still a
    // string from a server response and must not be able to inject markup.
    const html = render({ url: '/spectate/"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
  });

  test("renders in every language, with its own countdown and labels", () => {
    for (const slug of LANGUAGE_SLUGS) {
      const messages = getLanguage(slug).messages;
      const html = render({ messages });
      expect(html).toContain(messages.bookedTitle);
      expect(html).toContain(messages.joinCall);
      expect(html).toContain(messages.stayHere);
      expect(html).toContain("20");
      expect(html).not.toContain("{");
    }
  });

  test("gives the heading a focus target, so focus is not dropped on the body", () => {
    expect(render()).toContain("tabindex=\"-1\"");
  });
});
