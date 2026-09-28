import "server-only";

import { randomUUID } from "crypto";
import type { WebhookVendor } from "./verify";

/**
 * Accepted vendor-event ingestion (#65).
 *
 * An in-memory append log. That is a deliberate stopgap, not the design:
 * it is per-instance and does not survive a serverless cold start, so a
 * vendor event acknowledged here can still be lost before anyone acts on
 * it. The durable backing store is #17; when it lands, this module keeps
 * its interface and swaps the array for a table.
 */

export interface WebhookEvent {
  id: string;
  vendor: WebhookVendor;
  /** The vendor's event name (`type` / `event` / `eventType` / `status`), else "unknown". */
  type: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

const events: WebhookEvent[] = [];

/**
 * Where vendors put the event name, in priority order.
 *
 * Twilio status callbacks use `Status`, ElevenLabs agent events use `type` or
 * `event`. None of the vendors agree, on the name or on the casing, so keys are
 * normalised before comparison -- the same normalise-then-match approach the
 * logger's allowlist uses in @/lib/logger/redact.
 */
const TYPE_KEYS = ["type", "event", "eventtype", "status"] as const;

const MAX_TYPE_LENGTH = 120;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Extract the vendor's event name from a payload.
 *
 * Bounded on purpose: `type` is caller-influenced in the sense that any holder
 * of a valid vendor secret chooses it, and this string is used as a log field
 * and echoed in a response. An unbounded copy would let one caller pin a
 * large blob in memory and in the logs.
 */
export function deriveEventType(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload);

  for (const wanted of TYPE_KEYS) {
    for (const [key, value] of entries) {
      if (normalizeKey(key) !== wanted) continue;
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, MAX_TYPE_LENGTH);
      }
    }
  }

  return "unknown";
}

export function appendWebhookEvent(input: {
  vendor: WebhookVendor;
  type: string;
  payload: Record<string, unknown>;
}): WebhookEvent {
  const event: WebhookEvent = {
    id: randomUUID(),
    vendor: input.vendor,
    type: input.type,
    receivedAt: new Date().toISOString(),
    payload: input.payload,
  };
  events.push(event);
  return event;
}

export function listWebhookEvents(): readonly WebhookEvent[] {
  return [...events];
}

/** Test seam: drops buffered events between tests. */
export function clearWebhookEvents(): void {
  events.length = 0;
}
