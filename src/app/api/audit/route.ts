import { NextResponse } from 'next/server';
import {
  AUDIT_ACTIONS,
  AuditDetailsError,
  readAuditLog,
  recordAuditEvent,
  verifyAuditChain,
} from '@/lib/audit';
import { auditEntrySchema } from '@/lib/validation/intake';
import { parseJsonBody } from '@/lib/validation/parse';
import { requireInternalSecret } from '@/lib/auth/internal';
import { logError } from '@/lib/logger';

/**
 * The audit endpoints.
 *
 * Both were thin wrappers over an in-memory `AuditLogManager` that nothing else
 * used: the booking path and the record read did not write entries, and a
 * serverless cold start took the whole trail with it. The chain logic is the
 * same and now lives behind a store, so this is where a configured DATABASE_URL
 * starts to matter.
 *
 * What has tightened is the write. `action` used to be any string and `details`
 * any object, which meant an internal caller could put a symptom description
 * into a log that cannot be redacted and now cannot be dropped. Actions are the
 * closed set the application itself uses, and details are the three
 * non-identifying fields in src/lib/audit/store.ts; anything else is a 400
 * rather than a permanent copy. No caller in this repository used the wider
 * shape, so nothing here is a regression for a real caller and a good deal of
 * exposure to a hypothetical one.
 */

export async function POST(request: Request) {
  // Unauthenticated writes let anyone forge audit entries, attributing access
  // to a clinician who never made it. Reads below are guarded for the same
  // reason: the trail contains PHI in `details`.
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  try {
    const parsed = await parseJsonBody(request, auditEntrySchema);
    if (!parsed.ok) return parsed.response;

    const { actor, action, resource, details } = parsed.data;

    if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      return unsupportedAction();
    }

    const entry = await recordAuditEvent({
      actor,
      action: action as (typeof AUDIT_ACTIONS)[number],
      resource,
      details,
    });

    return NextResponse.json({ success: true, entry });
  } catch (error) {
    // A details payload outside the closed set. The key is named and the value
    // is not, so the 400 cannot itself become the copy the caller was refused.
    if (error instanceof AuditDetailsError) {
      return NextResponse.json(
        { error: 'Unsupported audit details', key: error.key },
        { status: 400 },
      );
    }

    // A durable store that is down fails closed: the entry was not written, so
    // the caller is told so rather than being handed a success it can rely on.
    logError('audit.failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  // Verification reads the whole chain regardless of what the response is
  // bounded to: a check over the last 200 entries would answer a question about
  // the tail and report it as a question about the log.
  const [logs, isValid] = await Promise.all([readAuditLog(), verifyAuditChain()]);

  return NextResponse.json({ logs, isValid });
}

function unsupportedAction() {
  // The allowed set comes back with the refusal, and the rejected value does not:
  // an action string is caller-supplied and this response is not private.
  return NextResponse.json(
    { error: 'Unsupported audit action', allowed: AUDIT_ACTIONS },
    { status: 400 },
  );
}
