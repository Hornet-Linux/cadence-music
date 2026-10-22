import { ApiError } from "../../builtins/server/serverStore";

/** The server's own short explanation ("The device did not respond.") without the HTTP wrapper around it. */
export function friendlyError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    const m = /^Request failed \(\d+\): (.*)$/.exec(err.message);
    if (m?.[1]) return m[1];
    if (err.status === 404) return "The device is no longer available.";
    return fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
