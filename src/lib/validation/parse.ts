import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Request-body parsing helpers shared by the API routes and the server action.
 *
 * Every route did `await request.json()` and used the result blind. The one
 * route that checked anything checked for the presence of three fields and
 * answered 401, which is an authentication status for a malformed request.
 *
 * Two layers on purpose. `parseWith` returns plain serializable data, because
 * a server action's return value crosses the server/client boundary and a
 * NextResponse does not survive that. `parseJsonBody` is the HTTP-shaped
 * wrapper for route handlers.
 */

export interface FieldIssue {
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; data: T } | { ok: false; issues: FieldIssue[] };

/** Validate an already-decoded body. Serializable, so usable in an action. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  body: unknown,
): Validated<z.output<S>> {
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: describe(result.error) };
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/** Read and validate a JSON body, answering 400 with per-field detail. */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<ParseResult<z.output<S>>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const result = parseWith(schema, body);
  if (result.ok) return result;

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Invalid request body", issues: result.issues },
      { status: 400 },
    ),
  };
}

export function badRequest(error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status: 400 }) };
}

/**
 * Flatten a ZodError into `{ field, message }` pairs.
 *
 * Field names are echoed back so the form can highlight the offending input.
 * The values are not: a validation error on a date of birth or an email
 * address should not restate the rejected value into a response body.
 */
export function describe(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}
