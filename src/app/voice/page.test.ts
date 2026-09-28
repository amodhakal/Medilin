import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";

import { LIVE_LANGUAGE_SLUGS } from "@/i18n/registry";
import { resetServerEnvCache } from "@/lib/env";
import VoiceIndexPage from "./page";

/**
 * /voice, tested.
 *
 * The interesting decision on this page is what it does when voice is not
 * configured: it offers the form instead. That is a deployment fact, decided
 * server-side, and it is exactly the kind of thing that regresses silently --
 * the page still renders, still looks fine, and every link on it leads to a
 * screen that can only say it is unavailable.
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

/** Every href in the rendered tree. */
function hrefs(element: unknown): string[] {
  const found: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!React.isValidElement(node)) return;
    const { props } = node as { props?: { children?: unknown; href?: unknown } };
    if (typeof props?.href === "string") found.push(props.href);
    walk(props?.children);
  };

  walk(element);
  return found;
}

function render() {
  return VoiceIndexPage();
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

describe("with voice configured", () => {
  test("links to every bookable language and nothing else", () => {
    const linked = hrefs(render()).filter((href) => href.startsWith("/voice/"));

    // One card per language the form can book in. A pending language has no
    // page here, and a card that leads to a 404 is a card that is lying.
    expect(linked.sort()).toEqual(LIVE_LANGUAGE_SLUGS.map((slug) => `/voice/${slug}`).sort());
  });

  test("always offers the form as a way out", () => {
    // A patient who opened this because the form was hard to read must be able
    // to reach the form without recording anything.
    expect(hrefs(render())).toContain("/language/english");
  });
});

describe("without a voice credential", () => {
  test("offers no language at all, and says why", () => {
    setEnv(["ELEVENLABS_API_KEY"]);

    // The hrefs are the whole assertion: no card, and so no link. The second
    // expectation is here because "no link to a voice page" and "still a working
    // form" are the same decision, and a page that removed both would pass the
    // first.
    const linked = hrefs(render()).filter((href) => href.startsWith("/voice/"));

    expect(linked).toEqual([]);
    expect(hrefs(render())).toContain("/language/english");
  });

  test("still offers the form", () => {
    setEnv(["ELEVENLABS_API_KEY"]);

    expect(hrefs(render())).toContain("/language/english");
  });
});
