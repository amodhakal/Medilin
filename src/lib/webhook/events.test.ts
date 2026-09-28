import { describe, expect, test } from "bun:test";
import { appendWebhookEvent, clearWebhookEvents, deriveEventType, listWebhookEvents } from "./events";

describe("deriveEventType", () => {
  test("reads the event name from each vendor's field", () => {
    expect(deriveEventType({ type: "call.completed" })).toBe("call.completed");
    expect(deriveEventType({ event: "agent.spoke" })).toBe("agent.spoke");
    expect(deriveEventType({ eventType: "conversation.started" })).toBe("conversation.started");
    expect(deriveEventType({ event_type: "message.received" })).toBe("message.received");
    expect(deriveEventType({ Status: "completed" })).toBe("completed");
  });

  test("falls back to unknown rather than inventing a name", () => {
    expect(deriveEventType({})).toBe("unknown");
    expect(deriveEventType({ type: "" })).toBe("unknown");
    expect(deriveEventType({ type: "   " })).toBe("unknown");
    expect(deriveEventType({ type: 42 })).toBe("unknown");
    expect(deriveEventType({ type: { nested: "no" } })).toBe("unknown");
  });

  test("bounds a caller-chosen event name", () => {
    // The holder of a valid vendor secret picks this string, and it reaches a
    // log field and a response, so it cannot be allowed to be unbounded.
    const long = "e".repeat(5_000);
    expect(deriveEventType({ type: long })).toHaveLength(120);
  });

  test("trims surrounding whitespace", () => {
    expect(deriveEventType({ type: "  call.completed\n" })).toBe("call.completed");
  });
});

describe("webhook event store", () => {
  test("persists accepted events in arrival order", () => {
    clearWebhookEvents();
    const first = appendWebhookEvent({ vendor: "twilio", type: "call.completed", payload: { a: 1 } });
    const second = appendWebhookEvent({ vendor: "elevenlabs", type: "call.ended", payload: {} });

    const listed = listWebhookEvents();
    expect(listed.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(first.receivedAt).toBeTruthy();
    expect(second.vendor).toBe("elevenlabs");
  });

  test("assigns a unique id to each event", () => {
    clearWebhookEvents();
    const ids = new Set(
      Array.from({ length: 10 }, () =>
        appendWebhookEvent({ vendor: "twilio", type: "sms.received", payload: {} }),
      ).map((event) => event.id),
    );
    expect(ids.size).toBe(10);
  });
});
