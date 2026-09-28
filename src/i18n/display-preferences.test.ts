import { describe, expect, test } from "bun:test";

import {
  BANDWIDTH_STORAGE_KEY,
  readStoredPreference,
  shouldReduceData,
  type BandwidthPreference,
} from "./display-preferences";

/**
 * When the low-bandwidth mode turns itself on.
 *
 * The mode is a stylesheet keyed off one attribute, and the only decision in it
 * is this one: does this visitor start in the reduced mode, and does their own
 * choice outrank the browser's guess. Everything else is CSS.
 */

describe("automatic low-bandwidth detection", () => {
  test("stays off on a fast connection", () => {
    expect(shouldReduceData({ effectiveType: "4g" }, null)).toBe("full");
  });

  test("turns on when the OS asked the browser to save data", () => {
    expect(shouldReduceData({ saveData: true }, null)).toBe("low");
  });

  test("turns on on a 2g connection", () => {
    expect(shouldReduceData({ effectiveType: "2g" }, null)).toBe("low");
    expect(shouldReduceData({ effectiveType: "slow-2g" }, null)).toBe("low");
  });

  test("leaves 3g alone", () => {
    // "3g" is a label the browser assigns, and putting everyone it labels
    // that way into a degraded page is a change they did not ask for.
    expect(shouldReduceData({ effectiveType: "3g" }, null)).toBe("full");
  });

  test("stays off where the browser tells us nothing", () => {
    // No Network Information API at all, which is most non-Chromium browsers.
    expect(shouldReduceData({}, null)).toBe("full");
  });

  test("honours a saved preference that disagrees with the connection", () => {
    expect(shouldReduceData({ saveData: true }, "full")).toBe("full");
    expect(shouldReduceData({ effectiveType: "4g" }, "low")).toBe("low");
  });
});

describe("the patient's own choice", () => {
  const choices: BandwidthPreference[] = ["low", "full"];

  for (const choice of choices) {
    test(`outranks the connection when set to ${choice}`, () => {
      expect(shouldReduceData({ saveData: choice === "low" }, choice)).toBe(choice);
      expect(shouldReduceData({ effectiveType: "2g" }, choice)).toBe(choice);
    });
  }

  test("is remembered under a versioned, namespaced key", () => {
    // A localStorage key is a shared namespace with every other script on the
    // origin and with every past version of this page.
    expect(BANDWIDTH_STORAGE_KEY).toMatch(/^[a-z0-9.-]+$/);
    expect(BANDWIDTH_STORAGE_KEY).toContain(".");
  });

  test("is null when nothing readable is stored", () => {
    expect(readStoredPreference()).toBeNull();
  });
});
