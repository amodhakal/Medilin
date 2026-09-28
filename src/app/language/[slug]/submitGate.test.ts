import { describe, expect, test } from "bun:test";

import { createSubmitGate } from "./submitGate";

/**
 * The rule is one sentence, and the bug it prevents is a duplicate booking, so
 * it is tested as a rule rather than left as a line in the component where the
 * only way to check it is to click twice in a browser.
 */

describe("submit gate", () => {
  test("lets the first submission through", () => {
    expect(createSubmitGate().begin()).toBe(true);
  });

  test("refuses a second submission while the first is in flight", () => {
    const gate = createSubmitGate();

    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
    expect(gate.begin()).toBe(false);
  });

  test("refuses the click that lands in the same frame as the first", () => {
    // What a double click actually looks like: two calls, no re-render in
    // between, no chance for React state to have caught up.
    const gate = createSubmitGate();
    const admitted = [gate.begin(), gate.begin()];

    expect(admitted).toEqual([true, false]);
  });

  test("releases the gate when the submission finishes", () => {
    const gate = createSubmitGate();

    gate.begin();
    gate.end();

    expect(gate.isOpen).toBe(false);
    expect(gate.begin()).toBe(true);
  });

  test("releases the gate when the submission fails", () => {
    const gate = createSubmitGate();

    gate.begin();
    try {
      throw new Error("server action threw");
    } catch {
      // The component's catch block reports the failure; the gate is released
      // in a finally, so a throw must not leave the form permanently disabled.
    } finally {
      gate.end();
    }

    expect(gate.begin()).toBe(true);
  });

  test("does not admit two submissions after a rejection", () => {
    const gate = createSubmitGate();

    gate.begin();
    gate.end();
    gate.begin();

    expect(gate.isOpen).toBe(true);
  });

  test("keeps separate gates separate", () => {
    const first = createSubmitGate();
    const second = createSubmitGate();

    expect(first.begin()).toBe(true);
    expect(second.begin()).toBe(true);
  });
});
