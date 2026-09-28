import { describe, expect, test } from "bun:test";
import { parseWith, describe as describeIssues } from "./parse";
import { z } from "zod";

const schema = z.object({ a: z.string().min(2), b: z.number() }).strict();

describe("parseWith", () => {
  test("returns data on success", () => {
    const result = parseWith(schema, { a: "ok", b: 1 });
    expect(result).toEqual({ ok: true, data: { a: "ok", b: 1 } });
  });

  test("returns serializable issues on failure", () => {
    const result = parseWith(schema, { a: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // A server action's return value crosses the server/client boundary, so
    // this must not contain a Response or an Error.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("collects every failing field", () => {
    const result = parseWith(schema, { a: "x", b: "nope" });
    if (result.ok) throw new Error("unreachable");
    expect(result.issues.map((i) => i.field).sort()).toEqual(["a", "b"]);
  });

  test("rejects unknown keys", () => {
    expect(parseWith(schema, { a: "ok", b: 1, extra: true }).ok).toBe(false);
  });

  test("does not echo the rejected value back", () => {
    const result = parseWith(schema, { a: "x", b: "sensitive-value" });
    if (result.ok) throw new Error("unreachable");
    // The rejected value could be a date of birth or an email address.
    expect(JSON.stringify(result.issues)).not.toContain("sensitive-value");
  });

  test("labels a root-level failure", () => {
    const result = parseWith(schema, "not an object");
    if (result.ok) throw new Error("unreachable");
    expect(result.issues[0].field).toBe("(root)");
  });
});

describe("describe", () => {
  test("flattens paths", () => {
    const nested = z.object({ a: z.object({ b: z.string() }) });
    const result = nested.safeParse({ a: { b: 1 } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(describeIssues(result.error)).toEqual([
      { field: "a.b", message: expect.any(String) },
    ]);
  });
});
