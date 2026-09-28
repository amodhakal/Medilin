import { NextResponse } from 'next/server';
import { auditLogger } from '@/lib/audit';
import { auditEntrySchema } from '@/lib/validation/intake';
import { parseJsonBody } from '@/lib/validation/parse';

export async function POST(request: Request) {
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

export async function GET() {
  const logs = auditLogger.getLogs();
  const isValid = auditLogger.verifyChain();
  return NextResponse.json({ logs, isValid });
}
