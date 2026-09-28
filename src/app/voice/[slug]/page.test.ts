import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";

import { LIVE_LANGUAGE_SLUGS, PENDING_LANGUAGE_SLUGS } from "@/i18n/registry";
import { resetServerEnvCache } from "@/lib/env";
import VoiceIntakePage from "./page";

/**
 * /voice/[slug], tested.
 *
 * The page has exactly two jobs and both of them are decisions a patient should
 * not be able to get wrong by editing a URL: which language this is, and
 * whether voice is available at all. Neither is testable from the browser, and
 * the form route's own test is the precedent -- the previous version of that
 * page resolved its slug in the browser with a cast, and nothing could catch it.
 *
 * So this mirrors `language/[slug]/page.test.ts`: render the component, and read
 * the element it returns.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const saved = new Map<string, string | undefined>();
for (const key of Object.keys(BASELINE)) saved.set(key, process.env[key]);

function setEnv(without: string[] = []): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  for (const [key, value] of Object.entries(BASELINE)) {
    if (without.includes(key)) continue;
    process.env[key] = value;
  }
  resetServerEnvCache();
}

function render(slug: string) {
  return VoiceIntakePage({ params: Promise.resolve({ slug }) });
}

/**
 * The props of the client component somewhere in the tree, or null.
 *
 * A walk rather than a child lookup, because the page nests the intake inside
 * the page chrome and a test that only looks one level down would keep passing
 * after the component moved.
 */
function findIntake(node: unknown): Record<string, unknown> | null {
  // Arrays: JSX with more than one child in a position hands the renderer a
  // list, and a walk that only follows a single node stops at the first one.
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findIntake(child);
      if (found) return found;
    }
    return null;
  }

  if (!React.isValidElement(node)) return null;

  const element = node as { type: unknown; props?: { children?: unknown } };
  if (typeof element.type === "function") return element.props as Record<string, unknown>;

  return findIntake(element.props?.children);
}

async function intakeProps(slug: string): Promise<Record<string, unknown> | null> {
  return findIntake(await render(slug));
}

async function notFoundDigest(slug: string): Promise<string | undefined> {
  try {
    await render(slug);
    return undefined;
  } catch (error) {
    return (error as { digest?: string }).digest;
  }
}

beforeEach(() => {
  setEnv();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("a bookable language", () => {
  for (const slug of LIVE_LANGUAGE_SLUGS) {
    test(`renders the ${slug} intake`, async () => {
      const props = await intakeProps(slug);

      expect(props).not.toBeNull();
      expect(props?.slug).toBe(slug);
      expect((props?.language as { status: string }).status).toBe("live");
      // The copy for the page, so a language that cannot answer the voice
      // screens is a compile error rather than a page of English.
      expect(typeof (props?.messages as { title: string }).title).toBe("string");
    });
  }
});

describe("a language we cannot book in", () => {
  test("is a 404, not a screen in the wrong language", async () => {
    for (const slug of [...PENDING_LANGUAGE_SLUGS, "klingon", "", "ENGLISH", "toString"]) {
      expect(await notFoundDigest(slug)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  });
});

describe("a deployment with no voice credential", () => {
  test("offers the form instead of a recording button that cannot work", async () => {
    setEnv(["ELEVENLABS_API_KEY"]);

    // The intake component is not rendered at all, rather than rendered in a
    // disabled state: a page that shows a control which cannot work is asking
    // the patient to discover the problem themselves.
    expect(await intakeProps("english")).toBeNull();
  });

  test("still resolves its language, so the fallback form is in the right one", async () => {
    setEnv(["ELEVENLABS_API_KEY"]);
    const element = await render("spanish");

    // The link out of the notice points at the *Spanish* form. A fallback that
    // dropped the slug would send a Spanish speaker to an English form, which
    // is the one thing this page must never do on any code path.
    const hrefs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!React.isValidElement(node)) return;
      const { props } = node as { props?: { children?: unknown; href?: unknown } };
      if (typeof props?.href === "string") hrefs.push(props.href);
      walk(props?.children);
    };
    walk(element);

    expect(hrefs).toContain("/language/spanish");
  });
});
