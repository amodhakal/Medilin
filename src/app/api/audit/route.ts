import { NextResponse } from 'next/server';
import { auditLogger } from '@/lib/audit';
import { auditEntrySchema } from '@/lib/validation/intake';
import { parseJsonBody } from '@/lib/validation/parse';
import { requireInternalSecret } from '@/lib/auth/internal';

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
    const entry = auditLogger.log(actor, action, resource, details);
    return NextResponse.json({ success: true, entry });
  } catch (error) {
    console.error('Audit API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  const logs = auditLogger.getLogs();
  const isValid = auditLogger.verifyChain();
  return NextResponse.json({ logs, isValid });
}
