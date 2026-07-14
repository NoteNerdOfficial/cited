/** `catch` clauses are typed `unknown`; this is the one place that decides
 *  how to turn that into user-facing text, so every catch site gets
 *  consistent (and type-safe) handling instead of repeating `(err as
 *  Error).message` -- which silently produces "undefined" for a
 *  non-Error throw instead of failing loudly or falling back sanely. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True if `err` is a Node filesystem error with code "ENOENT" ("file
 *  doesn't exist"), without relying on Node's ambient `NodeJS.ErrnoException`
 *  type at the call site. */
export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
