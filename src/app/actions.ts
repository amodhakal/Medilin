"use server";

import { headers } from "next/headers";
import {
  intakeFromFormData,
  intakeSchema,
  type IntakeFormData,
} from "@/lib/validation/intake";
import { parseWith, type FieldIssue } from "@/lib/validation/parse";

export type SubmitIntakeResult =
  | { ok: true; spectateUrl: string; appointmentId: string }
  | { ok: false; error: string; issues: FieldIssue[] };

export async function submitIntakeForm(formData: FormData): Promise<SubmitIntakeResult> {
  // Validate before spending anything. The form's `required` attributes are
  // a client-side convenience and are trivially bypassed, so this is the
  // only place a submission is actually checked before it reaches the API.
  const parsed = parseWith(intakeSchema, intakeFromFormData(formData));
  if (!parsed.ok) {
    return {
      ok: false,
      error: "Please check the highlighted fields",
      issues: parsed.issues,
    };
  }

  const data: IntakeFormData = parsed.data;

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";

  const response = await fetch(`${protocol}://${host}/api/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    spectateUrl?: string;
    appointmentId?: string;
    error?: string;
    issues?: FieldIssue[];
  } | null;

  // The old code returned response.json() and reported success by truthiness.
  // A 500 with an error body was indistinguishable from a booking.
  if (!response.ok || !body?.success || !body.spectateUrl || !body.appointmentId) {
    return {
      ok: false,
      error: body?.error ?? `Request failed with status ${response.status}`,
      issues: body?.issues ?? [],
    };
  }

  return {
    ok: true,
    spectateUrl: body.spectateUrl,
    appointmentId: body.appointmentId,
  };
}
